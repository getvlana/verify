# vlana-verify

Don't trust [Vlana](https://github.com/getvlana/vlana), check it. One command, no install, no dependencies, Node 18+.

```sh
npx github:getvlana/verify
```

```
▸ https://go.vlana.app serves the public code
  claims getvlana/vlana @ b1f3d21140a8
  ✓ /            = app/public/index.html  307f487f70b0f526
  ✓ /install.sh  = app/node/install.sh  d9d985e06992d29b
  ✓ /agent.py    = app/node/agent.py  f95767d850b2d78c

▸ payout rounds add up and are on Solana
  ✓ round 412        0.8312 SOL → 3 nodes  tx 4aSA…EASN · 2026-11-02 14:00 UTC
  ✓ round 411        0.6127 SOL → 3 nodes  tx mBwA…r9Lp · 2026-11-02 13:00 UTC

nothing to distrust
```

## What it checks

**`verify`**: everything below, for the last 6 rounds.

1. **The code.** The server says which commit it runs. Every file it serves (the app you sign in with, the installer node operators run as root, the node agent) is downloaded from the live site and from GitHub at that commit, and the SHA-256s must match.
2. **The payouts.** Each hourly round has a receipt: fees in, the pool, every node's checks, who made the cut, who got what. The tool hashes the receipt, finds the memo `vlana:r<round>:<sha256>` on Solana, checks the treasury signed it, and redoes the whole split itself.

**`verify round <n>`**: one round in full, node by node, with the transfers it sent.

**`verify me`**: is this machine going through Vlana right now, and which exit node and operator carry it.

## Options

| flag | default | |
|---|---|---|
| `--api` | `https://go.vlana.app` | any Vlana deployment |
| `--rpc` | `https://api.mainnet-beta.solana.com` | Solana RPC for the memo lookups |
| `--rounds` | `6` | how many recent rounds to check |

Exit code is `1` if anything doesn't match, so it drops straight into CI. That's what [`getvlana/vlana`](https://github.com/getvlana/vlana)'s hourly **live** badge does.

## What it can't prove

The server's own code. Nobody outside can see what a remote machine runs, so Vlana keeps the parts you can check where it matters: the code that touches your device and node servers, and the money, which is on-chain.

The receipt can't show the "one paid node per /24" rule either: that needs node IPs, which stay private.

## License

AGPL-3.0
