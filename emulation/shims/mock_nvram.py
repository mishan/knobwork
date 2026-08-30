#!/usr/bin/env python3
"""
Stage 4: NVRAM Key-Value File & Sysfs Shim
Provides SQLite/JSON storage for Mazda CMU NVRAM keys and system state parameters.
"""

import os
import sys
import sqlite3
import json
import argparse

DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nvram_store.db")

class NVRAMShim:
    def __init__(self, db_path=DEFAULT_DB):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS nvram (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Seed default CMU NVRAM settings if empty
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM nvram")
            if cursor.fetchone()[0] == 0:
                defaults = {
                    "vehicle_type": "J36",
                    "region": "NA",
                    "language": "en_US",
                    "speed": "0",
                    "gear": "PARK",
                    "ignition": "ON",
                    "audio_volume": "15",
                    "display_theme": "DisplayTheme_02"
                }
                for k, v in defaults.items():
                    cursor.execute("INSERT INTO nvram (key, value) VALUES (?, ?)", (k, v))
                conn.commit()

    def get(self, key):
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM nvram WHERE key=?", (key,))
            row = cursor.fetchone()
            return row[0] if row else None

    def set(self, key, value):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("INSERT OR REPLACE INTO nvram (key, value) VALUES (?, ?)", (key, str(value)))
            conn.commit()

    def dump(self):
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT key, value FROM nvram")
            return dict(cursor.fetchall())

    def seed_sysfs(self, target_dir):
        keys_dir = os.path.join(target_dir, "nv-config", "keys")
        os.makedirs(keys_dir, exist_ok=True)
        store = self.dump()
        for k, v in store.items():
            key_file = os.path.join(keys_dir, k)
            with open(key_file, "w") as f:
                f.write(f"{v}\n")
        open(os.path.join(target_dir, "nv-config", "add"), "a").close()
        open(os.path.join(target_dir, "nv-config", "commit"), "a").close()
        print(f"[NVRAM] Seeded sysfs tree at {target_dir} with {len(store)} keys.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mazda CMU Mock NVRAM Manager")
    parser.add_argument("--get", help="Get value for NVRAM key")
    parser.add_argument("--set", nargs=2, metavar=("KEY", "VAL"), help="Set value for NVRAM key")
    parser.add_argument("--dump", action="store_true", help="Dump all NVRAM key-value pairs")
    parser.add_argument("--seed-sysfs", metavar="DIR", help="Export NVRAM sysfs directory structure")
    args = parser.parse_args()

    nvram = NVRAMShim()
    if args.get:
        val = nvram.get(args.get)
        print(f"{args.get} = {val}" if val is not None else f"Key '{args.get}' not found.")
    elif args.set:
        nvram.set(args.set[0], args.set[1])
        print(f"Set NVRAM {args.set[0]} = {args.set[1]}")
    elif args.dump:
        print(json.dumps(nvram.dump(), indent=2))
    elif args.seed_sysfs:
        nvram.seed_sysfs(args.seed_sysfs)
    else:
        parser.print_help()
