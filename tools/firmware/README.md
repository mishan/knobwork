# Firmware package tools

These portable wrappers unpack and repack Mazda Connect `.up` packages without
assuming a particular home directory or sibling checkout.

They are adapted from
[`checksummaster/mzd-packing-scripts`](https://github.com/checksummaster/mzd-packing-scripts),
revision `d19b347`, which is distributed under GPL-3.0. The adapted scripts are
also GPL-3.0-only; the complete license is in [COPYING](COPYING). They require
Bash, Info-ZIP (`zip`, `unzip`), `gzip`, and GNU `tar`/coreutils.

`pack_cmu.sh` works on a temporary copy and refuses to overwrite its output.
That protects the source tree, but does **not** make a repacked update safe to
install. Package signatures and the CMU's update/boot trust chain remain a
separate research problem.
