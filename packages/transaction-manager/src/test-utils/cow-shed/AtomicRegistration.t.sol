// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

struct Call {
    address target;
    uint256 value;
    bytes callData;
    bool allowFailure;
    bool isDelegateCall;
}

interface Vm {
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
    function etch(address, bytes calldata) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
}

interface Factory {
    function implementation() external view returns (address);
    function proxyOf(address) external view returns (address);
    function executeHooks(Call[] calldata, bytes32, uint256, address, bytes calldata) external;
}

interface Shed {
    function nonces(bytes32) external view returns (bool);
    function domainSeparator() external view returns (bytes32);
}

// Token, registrar and order authorization are doubles; Shed execution uses pinned Sepolia runtime.
contract LocalToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public failRevocation;
    error RevocationFailed();
    error InsufficientBalance();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFailRevocation(address spender) external {
        failRevocation = spender;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == failRevocation && amount == 0 && allowance[msg.sender][spender] != 0) {
            revert RevocationFailed();
        }
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        if (balanceOf[from] < amount) revert InsufficientBalance();
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract LocalRegistrar {
    uint64 public constant MIN_COMMITMENT_AGE = 60;
    uint64 public constant MAX_COMMITMENT_AGE = 3600;
    mapping(bytes32 => uint64) public commitmentAt;
    bytes32 public expectedCommitment;
    bytes32 public expectedRegistration;
    uint256 public price;
    uint256 public charge;
    address public registeredOwner;
    uint256 public registrations;
    error CommitmentTooNew();
    error CommitmentTooOld();
    error MissingCommitment();

    function configure(bytes32 commitment, bytes32 registration, uint256 amount) external {
        expectedCommitment = commitment;
        expectedRegistration = registration;
        price = amount;
        charge = amount;
    }

    function setCharge(uint256 amount) external {
        require(amount <= price, "price cap");
        charge = amount;
    }

    function commit(bytes32 commitment) external {
        require(
            commitmentAt[commitment] == 0 || block.timestamp >= commitmentAt[commitment] + MAX_COMMITMENT_AGE,
            "unexpired commitment"
        );
        commitmentAt[commitment] = uint64(block.timestamp);
    }

    function register(string calldata, address owner, bytes32, address, address, uint64, address token, bytes32)
        external
    {
        require(keccak256(msg.data) == expectedRegistration, "wrong registration");
        uint64 timestamp = commitmentAt[expectedCommitment];
        if (timestamp == 0) revert MissingCommitment();
        if (block.timestamp < timestamp + MIN_COMMITMENT_AGE) revert CommitmentTooNew();
        if (block.timestamp >= timestamp + MAX_COMMITMENT_AGE) revert CommitmentTooOld();
        delete commitmentAt[expectedCommitment];
        registeredOwner = owner;
        registrations += 1;
        LocalToken(token).transferFrom(msg.sender, address(this), charge);
    }
}

contract LocalComposable {
    struct Params {
        address handler;
        bytes32 salt;
        bytes staticInput;
    }
    mapping(address => mapping(bytes32 => bool)) public singleOrders;

    function create(Params calldata params, bool dispatch) external {
        require(dispatch, "discovery required");
        singleOrders[msg.sender][keccak256(abi.encode(params))] = true;
    }
}

contract AtomicRegistrationTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    Factory private constant factory = Factory(0x221c28Ec177CF7da6f837DfD0052Ba8F265Fb4CA);
    address private constant implementation = 0xF0D400089d5b9fACA64E3422AD6614546587cfFB;
    LocalToken private constant token = LocalToken(0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238);
    LocalRegistrar private constant registrar = LocalRegistrar(0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3);
    address private constant composable = 0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74;
    address private constant relayer = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
    address private constant stranger = address(0xBEEF);
    uint256 private constant price = 5_000_000;
    uint256 private constant budget = 1_000_000;
    uint256 private constant start = 1_800_000_000;
    uint256 private constant deadline = start + 7200;
    bytes32 private constant registrationNonce = bytes32(uint256(2));
    bytes32 private constant setupNonce = bytes32(uint256(1));
    Call[] private setup;
    Call[] private registration;
    address private owner;
    address private proxy;
    bytes32 private commitment;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(start);
        string memory runtime = vm.readFile("runtime.json");
        vm.etch(address(factory), vm.parseJsonBytes(runtime, ".factory.runtime"));
        vm.etch(implementation, vm.parseJsonBytes(runtime, ".implementation.runtime"));
        require(
            address(factory).codehash == bytes32(_word(vm.parseJsonBytes(runtime, ".factory.keccak256"), 0)),
            "factory runtime hash"
        );
        require(
            implementation.codehash == bytes32(_word(vm.parseJsonBytes(runtime, ".implementation.keccak256"), 0)),
            "implementation runtime hash"
        );
        require(factory.implementation() == implementation, "wrong factory implementation");
        vm.etch(address(token), address(new LocalToken()).code);
        vm.etch(address(registrar), address(new LocalRegistrar()).code);
        vm.etch(composable, address(new LocalComposable()).code);
        string memory input = vm.readFile("calls.json");
        Call[] memory setupInput = abi.decode(vm.parseJsonBytes(input, ".setup"), (Call[]));
        Call[] memory registrationInput = abi.decode(vm.parseJsonBytes(input, ".registration"), (Call[]));
        for (uint256 i; i < setupInput.length; ++i) {
            setup.push(setupInput[i]);
        }
        for (uint256 i; i < registrationInput.length; ++i) {
            registration.push(registrationInput[i]);
        }
        owner = vm.addr(1);
        proxy = factory.proxyOf(owner);
        require(proxy == abi.decode(vm.parseJsonBytes(input, ".proxy"), (address)), "SDK proxy mismatch");
        bytes memory commitData = setup[0].callData;
        commitment = bytes32(_word(commitData, 4));
        Call memory registerCall = registration[2];
        require(registerCall.target == address(registrar), "unexpected register position");
        registrar.configure(commitment, keccak256(registerCall.callData), price);
    }

    function _word(bytes memory data, uint256 offset) private pure returns (uint256 value) {
        assembly { value := mload(add(add(data, 32), offset)) }
    }

    function _signature(Call[] memory calls, bytes32 nonce, uint256 until) private returns (bytes memory) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            Call memory c = calls[i];
            hashes[i] = keccak256(
                abi.encode(
                    keccak256(
                        "Call(address target,uint256 value,bytes callData,bool allowFailure,bool isDelegateCall)"
                    ),
                    c.target,
                    c.value,
                    keccak256(c.callData),
                    c.allowFailure,
                    c.isDelegateCall
                )
            );
        }
        bytes32 message = keccak256(
            abi.encode(
                keccak256(
                    "ExecuteHooks(Call[] calls,bytes32 nonce,uint256 deadline)Call(address target,uint256 value,bytes callData,bool allowFailure,bool isDelegateCall)"
                ),
                keccak256(abi.encodePacked(hashes)),
                nonce,
                until
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("COWShed"),
                keccak256("2.1.0"),
                uint256(11155111),
                proxy
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, keccak256(abi.encodePacked(hex"1901", domain, message)));
        return abi.encodePacked(r, s, v);
    }

    function _execute(Call[] memory calls, bytes32 nonce, uint256 until) private returns (bool, bytes memory) {
        bytes memory signature = _signature(calls, nonce, until);
        vm.prank(stranger);
        return address(factory).call(abi.encodeCall(factory.executeHooks, (calls, nonce, until, owner, signature)));
    }

    function _setup() private {
        (bool success,) = _execute(setup, setupNonce, deadline);
        require(success, "public setup failed");
        require(Shed(proxy).nonces(setupNonce), "setup nonce unused");
        require(registrar.commitmentAt(commitment) == start, "commitment missing");
        require(token.balanceOf(proxy) == 0, "setup funded itself");
        require(token.allowance(proxy, relayer) == budget, "setup allowance");
        require(token.allowance(proxy, address(registrar)) == 0, "registrar preapproved");
        // Generated setup must authorize the actual conditional order for the Shed.
        bytes memory createData = setup[1].callData;
        bytes memory params = new bytes(createData.length - 4);
        for (uint256 i; i < params.length; ++i) {
            params[i] = createData[i + 4];
        }
        (LocalComposable.Params memory conditional,) = abi.decode(params, (LocalComposable.Params, bool));
        require(
            LocalComposable(composable).singleOrders(proxy, keccak256(abi.encode(conditional))), "order unauthorized"
        );
    }

    function _unchanged(uint256 balance) private view {
        require(!Shed(proxy).nonces(registrationNonce), "registration nonce consumed");
        require(registrar.commitmentAt(commitment) == start, "commitment consumed");
        require(registrar.registrations() == 0 && registrar.registeredOwner() == address(0), "name registered");
        require(token.balanceOf(proxy) == balance, "balance changed");
        require(token.balanceOf(address(registrar)) == 0, "registrar paid");
        require(token.allowance(proxy, address(registrar)) == 0, "registrar allowance changed");
        require(token.allowance(proxy, relayer) == budget, "bounded setup allowance lost");
    }

    function test_unfundedRegistrationBubblesAndPreservesNonce() public {
        _setup();
        vm.warp(start + 60);
        (bool success, bytes memory reason) = _execute(registration, registrationNonce, deadline);
        require(!success, "unfunded registration succeeded");
        require(
            keccak256(reason) == keccak256(abi.encodeWithSelector(LocalToken.InsufficientBalance.selector)),
            "register revert did not bubble"
        );
        _unchanged(0);
    }

    function test_tooNewRegistrationPreservesFundsAndApprovals() public {
        _setup();
        token.mint(proxy, price);
        vm.warp(start + 59);
        (bool success, bytes memory reason) = _execute(registration, registrationNonce, deadline);
        require(!success, "premature registration succeeded");
        require(
            keccak256(reason) == keccak256(abi.encodeWithSelector(LocalRegistrar.CommitmentTooNew.selector)),
            "wrong premature error"
        );
        _unchanged(price);
    }

    function test_expiredCommitmentPreservesNonce() public {
        _setup();
        token.mint(proxy, price);
        vm.warp(start + 3600);
        (bool success, bytes memory reason) = _execute(registration, registrationNonce, deadline);
        require(!success, "expired commitment accepted");
        require(
            keccak256(reason) == keccak256(abi.encodeWithSelector(LocalRegistrar.CommitmentTooOld.selector)),
            "wrong expiry error"
        );
        _unchanged(price);
    }

    function test_hookDeadlinePreservesNonce() public {
        _setup();
        token.mint(proxy, price);
        vm.warp(start + 61);
        (bool success, bytes memory reason) = _execute(registration, registrationNonce, start + 60);
        require(!success, "expired hook accepted");
        require(keccak256(reason) == keccak256(abi.encodeWithSignature("DeadlineElapsed()")), "wrong deadline error");
        _unchanged(price);
    }

    function _success(uint256 until) private {
        (bool success,) = _execute(registration, registrationNonce, until);
        require(success, "post-settlement registration failed");
        require(Shed(proxy).nonces(registrationNonce), "registration nonce unused");
        require(registrar.registeredOwner() == owner && registrar.registrations() == 1, "wrong name owner");
        require(registrar.commitmentAt(commitment) == 0, "commitment not consumed");
        require(
            token.balanceOf(proxy) == price - registrar.charge()
                && token.balanceOf(address(registrar)) == registrar.charge(),
            "wrong payment"
        );
        require(token.allowance(proxy, address(registrar)) == 0, "registrar allowance not revoked");
        require(token.allowance(proxy, relayer) == 0, "relayer allowance not revoked");
        (bool replay, bytes memory reason) = _execute(registration, registrationNonce, until);
        require(!replay, "replay succeeded");
        require(keccak256(reason) == keccak256(abi.encodeWithSignature("NonceAlreadyUsed()")), "wrong replay error");
        require(
            registrar.registrations() == 1 && token.balanceOf(proxy) == price - registrar.charge(),
            "replay changed state"
        );
    }

    function test_postSettlementPRegistersAtMinimumAgeAndRejectsReplay() public {
        _setup();
        token.mint(proxy, price + budget);
        // Settlement removes X before the post-hook; only P remains.
        vm.prank(relayer);
        token.transferFrom(proxy, owner, budget);
        require(token.balanceOf(proxy) == price && token.balanceOf(owner) == budget, "settlement balance");
        vm.warp(start + 60);
        _success(deadline);
    }

    function test_publicEarlySetupCanCompleteExactFundedRegistrationAtDeadline() public {
        _setup();
        // A lower live price leaves approval to revoke for both spenders.
        registrar.setCharge(price - 1);
        token.mint(proxy, price);
        vm.warp(start + 60);
        _success(start + 60);
    }

    function test_publicCommitmentCannotBurnNonceBeforeMaturity() public {
        vm.prank(stranger);
        registrar.commit(commitment);
        token.mint(proxy, price);
        (bool success, bytes memory reason) = _execute(registration, registrationNonce, deadline);
        require(!success, "public commitment bypassed age");
        require(
            keccak256(reason) == keccak256(abi.encodeWithSelector(LocalRegistrar.CommitmentTooNew.selector)),
            "wrong public commitment error"
        );
        require(proxy.code.length == 0, "failed hook deployed proxy");
        require(
            token.balanceOf(proxy) == price && registrar.commitmentAt(commitment) == start,
            "public attempt changed state"
        );
        vm.warp(start + 60);
        _success(deadline);
    }

    function _failedRevocation(address spender) private {
        _setup();
        registrar.setCharge(price - 1);
        token.mint(proxy, price);
        token.setFailRevocation(spender);
        vm.warp(start + 60);
        (bool success, bytes memory reason) = _execute(registration, registrationNonce, deadline);
        require(!success, "failed revocation accepted");
        require(
            keccak256(reason) == keccak256(abi.encodeWithSelector(LocalToken.RevocationFailed.selector)),
            "wrong revocation error"
        );
        _unchanged(price);
        token.setFailRevocation(address(0));
        _success(deadline);
    }

    function test_registrarRevocationFailureRollsBackRegistration() public {
        _failedRevocation(address(registrar));
    }

    function test_relayerRevocationFailureRollsBackRegistration() public {
        _failedRevocation(relayer);
    }
}
