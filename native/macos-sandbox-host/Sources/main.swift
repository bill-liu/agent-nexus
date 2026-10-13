import Foundation
import Virtualization
import CryptoKit
import Darwin

// Trusted Core controls lifecycle over inherited stdin/stdout; connect opens only a private same-user Unix socket, never a TCP listener or shell.
struct HostFailure: Error { let code: String; init(_ code: String) { self.code = code } }
struct Request: Codable {
    let protocolVersion: Int
    let commandId: String
    let command: String
    let sandboxId: String
    let generation: Int
    let operationId: String?
    let botId: String?
}
struct AllowedSandbox: Codable {
    let botId: String
    let disk: String
    let efi: String
    let bootISO: String?
    let bootSHA256: String?
    let cpuCount: Int
    let memoryBytes: UInt64
    let diskBytes: UInt64
    let networkMode: String?
}
struct Authority: Codable {
    let protocolVersion: Int
    let nodeId: String
    let targetId: String
    let expiresAt: Double
    let root: String
    let actions: [String]
    let sandboxes: [String: AllowedSandbox]
}
struct Record: Codable {
    var generation: Int
    let botId: String
    let operationId: String
    var state: String
    var hostBootID: String
}
func hostBootID() throws -> String {
    var size = 0
    guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1, size < 256 else { throw HostFailure("BOOT_ID_UNAVAILABLE") }
    var bytes = [CChar](repeating: 0, count: size)
    guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0 else { throw HostFailure("BOOT_ID_UNAVAILABLE") }
    return String(cString: bytes)
}
func recoveredState(_ record: Record, currentBootID: String) -> String {
    guard ["running", "starting", "unknown"].contains(record.state) else { return record.state }
    // A different kernel boot proves every prior local VM has stopped. Same-boot uncertainty remains blocked.
    return record.hostBootID != currentBootID ? "stopped" : "unknown"
}
func checkedPath(_ value: String, root: String, existing: Bool = true) throws -> URL {
    let base = URL(fileURLWithPath: root).standardizedFileURL
    let path = URL(fileURLWithPath: value).standardizedFileURL
    guard path.path.hasPrefix(base.path + "/"), path.resolvingSymlinksInPath().path == path.path else { throw HostFailure("PATH_DENIED") }
    if existing {
        let attrs = try FileManager.default.attributesOfItem(atPath: path.path)
        guard attrs[.type] as? FileAttributeType == .typeRegular, (attrs[.referenceCount] as? NSNumber)?.intValue == 1 else { throw HostFailure("PATH_DENIED") }
    }
    return path
}
func validate(_ request: Request) throws {
    guard request.protocolVersion == 1, ["create", "start", "stop", "inspect", "connect", "destroy"].contains(request.command), !request.commandId.isEmpty, request.commandId.count <= 128,
          !request.sandboxId.isEmpty, request.sandboxId.count <= 128, request.generation >= 0 else { throw HostFailure("INVALID_REQUEST") }
}
final class Host {
    let authority: Authority
    var records: [String: Record]
    var machines: [String: VZVirtualMachine] = [:]
    var bridges: [String: SocketBridge] = [:]
    let journal: URL
    let lockFD: Int32
    init(config: String) throws {
        let attrs = try FileManager.default.attributesOfItem(atPath: config)
        guard attrs[.type] as? FileAttributeType == .typeRegular, (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              (attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600, (attrs[.referenceCount] as? NSNumber)?.intValue == 1,
              URL(fileURLWithPath: config).resolvingSymlinksInPath().path == config else { throw HostFailure("PROTECTED_AUTHORIZATION_REQUIRED") }
        authority = try JSONDecoder().decode(Authority.self, from: Data(contentsOf: URL(fileURLWithPath: config)))
        guard authority.protocolVersion == 1, !authority.targetId.isEmpty, !authority.nodeId.isEmpty,
              authority.expiresAt > Date().timeIntervalSince1970 * 1000 else { throw HostFailure("AUTHORIZATION_EXPIRED") }
        let root = URL(fileURLWithPath: authority.root).standardizedFileURL
        let rootAttrs = try FileManager.default.attributesOfItem(atPath: root.path)
        guard root.path == root.resolvingSymlinksInPath().path, rootAttrs[.type] as? FileAttributeType == .typeDirectory,
              (rootAttrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(), (rootAttrs[.posixPermissions] as? NSNumber)?.intValue == 0o700 else { throw HostFailure("PRIVATE_ROOT_REQUIRED") }
        lockFD = open(root.appendingPathComponent("an-vm.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw HostFailure("HELPER_ALREADY_RUNNING") }
        journal = root.appendingPathComponent("an-vm-journal.json")
        if FileManager.default.fileExists(atPath: journal.path) {
            _ = try checkedPath(journal.path, root: authority.root)
            records = try JSONDecoder().decode([String: Record].self, from: Data(contentsOf: journal))
            // Core must reconcile interrupted operations. A stale journal is never a live health check.
            let currentBoot = try hostBootID()
            for id in Array(records.keys) { if let record = records[id] { records[id]?.state = recoveredState(record, currentBootID: currentBoot) } }
        } else { records = [:] }
    }
    func save() throws {
        try JSONEncoder().encode(records).write(to: journal, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: journal.path)
    }
    func response(_ request: Request, state: String) -> [String: Any] {
        ["protocolVersion": 1, "sandboxId": request.sandboxId, "generation": records[request.sandboxId]?.generation ?? 0,
         "state": state, "evidenceKind": "live", "observedAt": Date().timeIntervalSince1970 * 1000]
    }
    deinit { flock(lockFD, LOCK_UN); close(lockFD) }
    func prepareStorage(_ spec: AllowedSandbox) throws {
        guard spec.diskBytes >= 1024 * 1024 * 1024, spec.diskBytes <= 128 * 1024 * 1024 * 1024 else { throw HostFailure("RESOURCE_LIMIT_INVALID") }
        let disk = try checkedPath(spec.disk, root: authority.root, existing: false)
        let efi = try checkedPath(spec.efi, root: authority.root, existing: false)
        if !FileManager.default.fileExists(atPath: disk.path) {
            // Recovery leaves only this operation's private .partial; never touches unrelated files.
            let partial = disk.appendingPathExtension("partial")
            if FileManager.default.fileExists(atPath: partial.path) {
                _ = try checkedPath(partial.path, root: authority.root)
                try FileManager.default.removeItem(at: partial)
            }
            let fd = open(partial.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw HostFailure("DISK_CREATE_FAILED") }
            defer { close(fd) }
            guard ftruncate(fd, off_t(spec.diskBytes)) == 0, fsync(fd) == 0 else { throw HostFailure("DISK_CREATE_FAILED") }
            try FileManager.default.moveItem(at: partial, to: disk)
        }
        if !FileManager.default.fileExists(atPath: efi.path) {
            _ = try VZEFIVariableStore(creatingVariableStoreAt: efi, options: [])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: efi.path)
        }
    }
    func configuration(_ spec: AllowedSandbox) throws -> VZVirtualMachineConfiguration {
        guard spec.cpuCount >= 1, spec.cpuCount <= min(8, VZVirtualMachineConfiguration.maximumAllowedCPUCount),
              spec.memoryBytes >= max(512 * 1024 * 1024, VZVirtualMachineConfiguration.minimumAllowedMemorySize),
              spec.memoryBytes <= min(16 * 1024 * 1024 * 1024, VZVirtualMachineConfiguration.maximumAllowedMemorySize),
              spec.diskBytes >= 1024 * 1024 * 1024, spec.diskBytes <= 128 * 1024 * 1024 * 1024 else { throw HostFailure("RESOURCE_LIMIT_INVALID") }
        let config = VZVirtualMachineConfiguration()
        config.cpuCount = spec.cpuCount
        config.memorySize = spec.memoryBytes
        let loader = VZEFIBootLoader()
        loader.variableStore = VZEFIVariableStore(url: try checkedPath(spec.efi, root: authority.root))
        config.bootLoader = loader
        config.platform = VZGenericPlatformConfiguration()
        let disk = try checkedPath(spec.disk, root: authority.root)
        let attributes = try FileManager.default.attributesOfItem(atPath: disk.path)
        guard (attributes[.size] as? NSNumber)?.uint64Value == spec.diskBytes else { throw HostFailure("DISK_SIZE_MISMATCH") }
        config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: disk, readOnly: false))]
        if let iso = spec.bootISO {
            let source = try checkedPath(iso, root: authority.root)
            guard spec.bootSHA256 == "2ee2163c9b901ff5926400e80759088ff3b879982a3956c02100495b489fd555" else { throw HostFailure("UNTRUSTED_BOOTSTRAP") }
            let handle = try FileHandle(forReadingFrom: source)
            defer { try? handle.close() }
            var hasher = SHA256()
            while let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty { hasher.update(data: bytes) }
            let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            guard actual == spec.bootSHA256 else { throw HostFailure("BOOTSTRAP_DIGEST_MISMATCH") }
            config.storageDevices.append(VZUSBMassStorageDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: source, readOnly: true)))
        }
        // NAT is opt-in protected device authorization, not a claim of guest policy enforcement.
        if spec.networkMode == "nat" {
            guard authority.actions.contains("network-egress") else { throw HostFailure("NETWORK_NOT_AUTHORIZED") }
            let network = VZVirtioNetworkDeviceConfiguration()
            network.attachment = VZNATNetworkDeviceAttachment()
            config.networkDevices = [network]
        } else if spec.networkMode == nil || spec.networkMode == "none" { config.networkDevices = [] }
        else { throw HostFailure("NETWORK_POLICY_UNSUPPORTED") }
        config.directorySharingDevices = []
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        try config.validate()
        return config
    }
    func handle(_ request: Request, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        do {
            try validate(request)
            guard (authority.expiresAt > Date().timeIntervalSince1970 * 1000 || ["inspect", "stop"].contains(request.command)),
                  authority.actions.contains(request.command), let spec = authority.sandboxes[request.sandboxId] else { throw HostFailure("OPERATION_NOT_AUTHORIZED") }
            if request.command == "create" {
                guard request.generation == 0, request.botId == spec.botId, let operation = request.operationId, !operation.isEmpty else { throw HostFailure("INVALID_CREATE") }
                if let prior = records[request.sandboxId] {
                    guard prior.operationId == operation && prior.botId == spec.botId else { throw HostFailure("IDEMPOTENCY_CONFLICT") }
                    completion(.success(response(request, state: prior.state))); return
                }
                // Allocation is reachable only with protected create authorization, never during preflight/tests.
                try prepareStorage(spec)
                _ = try configuration(spec)
                records[request.sandboxId] = Record(generation: 0, botId: spec.botId, operationId: operation, state: "created", hostBootID: try hostBootID())
                try save(); completion(.success(response(request, state: "created"))); return
            }
            guard var record = records[request.sandboxId], record.generation == request.generation else { throw HostFailure("STALE_SANDBOX") }
            switch request.command {
            case "inspect":
                let state: String
                if let machine = machines[request.sandboxId] { state = machine.state == .running ? "running" : machine.state == .stopped ? "stopped" : "unknown" }
                else { state = record.state }
                completion(.success(response(request, state: state)))
            case "start":
                guard record.state == "created" || record.state == "stopped", machines[request.sandboxId] == nil else { throw HostFailure("VM_NOT_STOPPED") }
                let machine = VZVirtualMachine(configuration: try configuration(spec))
                record.generation += 1; record.state = "starting"; record.hostBootID = try hostBootID(); records[request.sandboxId] = record; try save()
                machines[request.sandboxId] = machine
                machine.start { result in
                    do {
                        switch result {
                        case .success: self.records[request.sandboxId]?.state = "running"
                        case .failure: self.records[request.sandboxId]?.state = "unknown"
                        }
                        try self.save()
                        switch result {
                        case .success: completion(.success(self.response(request, state: "running")))
                        case .failure: completion(.failure(HostFailure("VM_START_FAILED")))
                        }
                    } catch { completion(.failure(HostFailure("JOURNAL_FAILED"))) }
                }
            case "stop":
                guard let machine = machines[request.sandboxId] else {
                    if record.state == "stopped" || record.state == "created" { completion(.success(response(request, state: record.state))); return }
                    throw HostFailure("VM_STATE_UNKNOWN")
                }
                machine.stop { error in
                    do {
                        guard error == nil else { completion(.failure(HostFailure("VM_STOP_FAILED"))); return }
                        self.records[request.sandboxId]?.state = "stopped"
                        self.bridges.removeValue(forKey: request.sandboxId)?.close()
                        self.machines.removeValue(forKey: request.sandboxId)
                        try self.save(); completion(.success(self.response(request, state: "stopped")))
                    } catch { completion(.failure(HostFailure("JOURNAL_FAILED"))) }
                }
            case "connect":
                guard let machine = machines[request.sandboxId], machine.state == .running,
                      let device = machine.socketDevices.first as? VZVirtioSocketDevice else { throw HostFailure("BLOCKED_NODE_CHANNEL_UNAVAILABLE") }
                device.connect(toPort: 47001) { connection, error in
                    do {
                        guard let connection, error == nil else { throw HostFailure("BLOCKED_NODE_CHANNEL_UNAVAILABLE") }
                        self.bridges.removeValue(forKey: request.sandboxId)?.close()
                        let path = URL(fileURLWithPath: self.authority.root).appendingPathComponent("channel-" + UUID().uuidString + ".sock").path
                        self.bridges[request.sandboxId] = try SocketBridge(path: path, guest: connection)
                        completion(.success(["protocolVersion": 1, "sandboxId": request.sandboxId, "generation": record.generation,
                                             "nodeId": self.authority.nodeId, "channelRef": path, "evidenceKind": "live"]))
                    } catch { completion(.failure(error)) }
                }
            case "destroy":
                guard record.state == "stopped" || record.state == "created", machines[request.sandboxId] == nil else { throw HostFailure("VM_NOT_STOPPED") }
                // Destroy retires the binding; deleting user data requires a separate explicit authorization.
                records[request.sandboxId]?.state = "destroyed"; try save(); completion(.success(response(request, state: "destroyed")))
            default: throw HostFailure("INVALID_REQUEST")
            }
        } catch { completion(.failure(error)) }
    }
}
func output(_ value: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
    }
}
if CommandLine.arguments.contains("--preflight") {
    output(["protocolVersion": 1, "status": "PREFLIGHT_ONLY", "virtualizationSupported": VZVirtualMachine.isSupported, "entitlementRequired": "com.apple.security.virtualization", "vmStarted": false])
} else if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--authority" {
    do {
        let host = try Host(config: CommandLine.arguments[2])
        DispatchQueue.global().async {
            while let line = readLine() {
                guard line.utf8.count <= 16384, let data = line.data(using: .utf8), let fields = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      Set(fields.keys).isSubset(of: ["protocolVersion", "commandId", "command", "sandboxId", "generation", "operationId", "botId"]),
                      let request = try? JSONDecoder().decode(Request.self, from: data) else { output(["error": "INVALID_REQUEST"]); continue }
                let finished = DispatchSemaphore(value: 0)
                DispatchQueue.main.async {
                    host.handle(request) { result in
                        switch result {
                        case .success(let value): output(value)
                        case .failure(let error): output(["error": (error as? HostFailure)?.code ?? "HELPER_FAILED"])
                        }
                        finished.signal()
                    }
                }
                finished.wait()
            }
            exit(0)
        }
        dispatchMain()
    } catch { output(["error": (error as? HostFailure)?.code ?? "BLOCKED_AUTHORIZATION"]); exit(2) }
} else { output(["error": "BLOCKED_PROTECTED_AUTHORIZATION_REQUIRED"]); exit(2) }
