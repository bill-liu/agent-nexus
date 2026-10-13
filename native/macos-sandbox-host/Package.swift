// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "ANSandboxHost", platforms: [.macOS(.v13)], products: [.executable(name: "an-sandbox-host", targets: ["ANSandboxHost"])], targets: [.executableTarget(name: "ANSandboxHost", path: "Sources"), .testTarget(name: "ANSandboxHostTests", dependencies: ["ANSandboxHost"], path: "Tests")])
