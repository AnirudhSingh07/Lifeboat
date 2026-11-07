// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LifeboatExecutor} from "../src/module/LifeboatExecutor.sol";
import {IERC7579Module, MODULE_TYPE_EXECUTOR} from "../src/module/IERC7579.sol";

/// @dev Minimal ERC-7579 account: holds funds and lets one installed executor act for it.
contract MockERC7579Account {
    address public executor;

    receive() external payable {}

    function installExecutor(address module, bytes calldata initData) external {
        executor = module;
        IERC7579Module(module).onInstall(initData);
    }

    function executeFromExecutor(bytes32, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory ret)
    {
        require(msg.sender == executor, "not executor");
        address to = address(bytes20(executionCalldata[0:20]));
        uint256 value = uint256(bytes32(executionCalldata[20:52]));
        bytes calldata data = executionCalldata[52:];
        (bool ok, bytes memory out) = to.call{value: value}(data);
        require(ok, "call failed");
        ret = new bytes[](1);
        ret[0] = out;
    }
}

/// @notice The Lifeboat timelock+veto governing an existing ERC-7579 account's funds.
contract LifeboatModuleTest is Test {
    LifeboatExecutor module;
    MockERC7579Account account;

    address hotKey = makeAddr("hotKey");
    address guardian = makeAddr("guardian");
    address recipient = makeAddr("recipient");
    uint64 constant TIMELOCK = 1 days;

    function setUp() public {
        module = new LifeboatExecutor();
        account = new MockERC7579Account();
        vm.deal(address(account), 100 ether);
        account.installExecutor(address(module), abi.encode(hotKey, guardian, TIMELOCK));
    }

    function test_installed() public view {
        assertTrue(module.isInitialized(address(account)));
        assertTrue(module.isModuleType(MODULE_TYPE_EXECUTOR));
        (address h, address g, uint64 t, bool installed) = module.policy(address(account));
        assertEq(h, hotKey);
        assertEq(g, guardian);
        assertEq(t, TIMELOCK);
        assertTrue(installed);
    }

    function test_requestOnlyHotKey() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(LifeboatExecutor.NotHotKey.selector);
        module.requestWithdrawal(address(account), recipient, 10 ether, "");
    }

    function test_executeAfterTimelock() public {
        vm.prank(hotKey);
        uint256 id = module.requestWithdrawal(address(account), recipient, 10 ether, "");
        vm.warp(block.timestamp + TIMELOCK + 1);
        module.executeWithdrawal(address(account), id);
        assertEq(recipient.balance, 10 ether);
        assertEq(address(account).balance, 90 ether);
    }

    function test_vetoBlocksExecution() public {
        vm.prank(hotKey);
        uint256 id = module.requestWithdrawal(address(account), recipient, 50 ether, "");
        vm.prank(guardian);
        module.veto(address(account), id);
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.expectRevert(LifeboatExecutor.AlreadyVetoed.selector);
        module.executeWithdrawal(address(account), id);
        assertEq(address(account).balance, 100 ether, "funds stay in the account");
    }

    function test_vetoOnlyGuardian() public {
        vm.prank(hotKey);
        uint256 id = module.requestWithdrawal(address(account), recipient, 1 ether, "");
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(LifeboatExecutor.NotGuardian.selector);
        module.veto(address(account), id);
    }
}
