// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeSend} from "../SafeSend.sol";

contract TestSafeSendV2 is SafeSend {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
