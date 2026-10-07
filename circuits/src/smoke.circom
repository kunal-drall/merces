pragma circom 2.2.3;
include "circomlib/circuits/poseidon.circom";
template Smoke() {
    signal input a; signal input b; signal output h;
    component p = Poseidon(2); p.inputs[0] <== a; p.inputs[1] <== b; h <== p.out;
}
component main = Smoke();
