import XCTest
@testable import ANSandboxHost
final class PolicyTests: XCTestCase {
    func testUnknownCommandRefused() {
        XCTAssertThrowsError(try validate(Request(protocolVersion: 1, commandId: "c", command: "shell", sandboxId: "s", generation: 0, operationId: nil, botId: nil)))
    }
    func testWrongProtocolRefused() {
        XCTAssertThrowsError(try validate(Request(protocolVersion: 99, commandId: "c", command: "inspect", sandboxId: "s", generation: 0, operationId: nil, botId: nil)))
    }
    func testOutsideRootRefused() {
        XCTAssertThrowsError(try checkedPath("/Users/other/.ssh/id", root: "/private/an", existing: false))
    }
    func testNegativeGenerationRefused() {
        XCTAssertThrowsError(try validate(Request(protocolVersion: 1, commandId: "c", command: "start", sandboxId: "s", generation: -1, operationId: nil, botId: nil)))
    }
}

final class RecoveryPolicyTests: XCTestCase {
    func testSameBootCrashRemainsUnknown() {
        let record = Record(generation: 2, botId: "b", operationId: "o", state: "running", hostBootID: "boot-a")
        XCTAssertEqual(recoveredState(record, currentBootID: "boot-a"), "unknown")
    }
    func testDifferentKernelBootProvesOldVMStopped() {
        let record = Record(generation: 2, botId: "b", operationId: "o", state: "unknown", hostBootID: "boot-a")
        XCTAssertEqual(recoveredState(record, currentBootID: "boot-b"), "stopped")
        XCTAssertEqual(record.generation, 2)
    }
    func testRetiredSandboxNotRevivedByReboot() {
        let record = Record(generation: 2, botId: "b", operationId: "o", state: "destroyed", hostBootID: "boot-a")
        XCTAssertEqual(recoveredState(record, currentBootID: "boot-b"), "destroyed")
    }
}
