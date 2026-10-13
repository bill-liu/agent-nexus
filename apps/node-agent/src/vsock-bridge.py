#!/usr/bin/env python3
"""B1 guest transport only. No shell, login or CLI launch. HMAC authentication stays end-to-end in channel.ts."""
import json
import os
import socket
import stat
import sys
import threading

def protected_config(path):
    value = os.lstat(path)
    if not stat.S_ISREG(value.st_mode) or value.st_uid != os.geteuid() or value.st_mode & 0o077 or value.st_nlink != 1 or os.path.realpath(path) != path:
        raise ValueError('PROTECTED_AUTHORIZATION_REQUIRED')
    with open(path, encoding='utf8') as source:
        config = json.load(source)
    if not config.get('targetId') or config.get('port') != 47001:
        raise ValueError('PROTECTED_AUTHORIZATION_REQUIRED')
    endpoint = config.get('nodeSocket', '')
    if not endpoint.startswith('/run/an-node/') or os.path.realpath(endpoint) != endpoint:
        raise ValueError('NODE_SOCKET_DENIED')
    info = os.stat(endpoint)
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('NODE_SOCKET_DENIED')
    return config

def pipe(source, destination):
    try:
        while True:
            data = source.recv(16384)
            if not data:
                break
            destination.sendall(data)
    except OSError:
        pass
    finally:
        for stream in (source, destination):
            try:
                stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

def main(path):
    config = protected_config(path)
    if not hasattr(socket, 'AF_VSOCK'):
        raise ValueError('VSOCK_UNAVAILABLE')
    with socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM) as listener:
        listener.bind((socket.VMADDR_CID_ANY, config['port']))
        listener.listen(1)
        # One active Core connection. Never spawn unbounded handlers on unauthenticated input.
        while True:
            peer, address = listener.accept()
            with peer:
                if address[0] != socket.VMADDR_CID_HOST:
                    continue
                config = protected_config(path)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as local:
                    local.connect(config['nodeSocket'])
                    thread = threading.Thread(target=pipe, args=(peer, local), daemon=True)
                    thread.start()
                    pipe(local, peer)
                    thread.join(timeout=1)

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('PROTECTED_AUTHORIZATION_REQUIRED')
        main(sys.argv[1])
    except (OSError, ValueError, KeyError):
        print('{"status":"BLOCKED","reason":"VSOCK_AUTHORIZATION_OR_CAPABILITY_REQUIRED"}')
        sys.exit(2)
