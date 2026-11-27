# Safety rules

These rules decide where a change is made and what must be true before it
reaches a CMU.

## Decision rule

Use the least invasive layer that can deliver the desired result:

| Goal | Preferred layer |
| --- | --- |
| UI layout/behavior | browser tests + USB overlay |
| Framework resilience | hybrid emulator + guarded overlay |
| Native service behavior | QEMU ARM userspace/full-system guest |
| File/config transaction | overlay manager or normal-mode package |
| Kernel/driver experiment | spare CMU or board-focused QEMU work |
| Failsafe/bootloader experiment | verified hardware recovery first |

## Hardware recovery gate

No boot-critical experiment proceeds until all are true:

- full NOR read captured twice with matching hashes;
- backup includes boot-select, IBC1, IBC2, failsafe, config, and secure-sector
  boundaries as supported by the programmer;
- external programmer can erase/write/verify a noncritical test chip or spare
  CMU reliably;
- serial console output is captured;
- power supply and ignition behavior are controlled on the bench;
- rollback steps are written and rehearsed;
- the stock signed 74 package remains available.

Separately investigate IBC Serial Downloader mode. Treat it as unproven until a
kernel can be loaded into RAM without writing persistent storage.

## Safe UI-development rules

Every deployable UI patch should pass:

1. syntax parsing using an Opera-12-compatible language target;
2. static checks for undeclared globals and overwritten prototypes;
3. clean load in the browser emulator;
4. scripted navigation through affected contexts;
5. error injection for missing scripts, bad dictionaries, and malformed
   WebSocket messages;
6. exact source-file hash precondition at install time;
7. atomic replacement and retained original;
8. automatic rollback after repeated HMI startup failure.

Avoid broad minification initially. It makes field diagnosis harder, can expose
old-engine parser bugs, and changes many boot-critical resources for relatively
small gains. Target measured hot paths and logging first.
