import Foundation
import Virtualization
import Darwin

/// Private local socket transports bytes to exactly one approved VM vsock connection.
/// Node protocol HMAC/binding validation is end-to-end above this bridge; a connected socket is not readiness.
final class SocketBridge {
    let path: String
    private let listener: Int32
    private let guest: VZVirtioSocketConnection
    private let lock = NSLock()
    private var closed = false
    private var peer: Int32 = -1
    private let workers = DispatchGroup()
    init(path: String, guest: VZVirtioSocketConnection) throws {
        guard path.utf8.count < 104 else { throw HostFailure("CHANNEL_PATH_TOO_LONG") }
        self.path = path; self.guest = guest
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw HostFailure("CHANNEL_SOCKET_FAILED") }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        path.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { bytes in
                _ = memcpy(bytes.baseAddress!, source, path.utf8.count + 1)
            }
        }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, chmod(path, 0o600) == 0, listen(listener, 1) == 0 else {
            Darwin.close(listener); unlink(path); throw HostFailure("CHANNEL_BIND_FAILED")
        }
        workers.enter()
        DispatchQueue.global().async { self.acceptPeer(); self.workers.leave() }
    }
    private func acceptPeer() {
        let client = accept(listener, nil, nil)
        guard client >= 0 else { close(); return }
        var uid: uid_t = 0; var gid: gid_t = 0
        guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else { Darwin.close(client); close(); return }
        lock.lock()
        if closed { lock.unlock(); Darwin.close(client); return }
        peer = client; lock.unlock()
        var enabled: Int32 = 1
        _ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        _ = setsockopt(guest.fileDescriptor, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        workers.enter()
        DispatchQueue.global().async { self.copy(from: client, to: self.guest.fileDescriptor); self.workers.leave() }
        copy(from: guest.fileDescriptor, to: client)
    }
    private func copy(from: Int32, to: Int32) {
        var bytes = [UInt8](repeating: 0, count: 16384)
        while true {
            let count = Darwin.read(from, &bytes, bytes.count)
            if count <= 0 { break }
            let success = bytes.withUnsafeBytes { buffer -> Bool in
                var offset = 0
                while offset < count {
                    let sent = Darwin.write(to, buffer.baseAddress!.advanced(by: offset), count - offset)
                    if sent <= 0 { return false }; offset += sent
                }
                return true
            }
            if !success { break }
        }
        close()
    }
    func close() {
        lock.lock(); defer { lock.unlock() }
        if closed { return }; closed = true
        shutdown(listener, SHUT_RDWR)
        if peer >= 0 { shutdown(peer, SHUT_RDWR) }
        shutdown(guest.fileDescriptor, SHUT_RDWR)
        unlink(path)
        // Never recycle a descriptor while a copy worker could still write to its numeric FD.
        workers.notify(queue: .global()) {
            Darwin.close(self.listener)
            if self.peer >= 0 { Darwin.close(self.peer) }
            // VZVirtioSocketConnection owns its FD and is released only after workers retire.
        }
    }

}
