#!/usr/bin/env python3
"""
Stage 4: NVRAM Key-Value File & Sysfs Shim
Provides SQLite/JSON storage for Mazda CMU NVRAM keys and system state parameters.
"""

import argparse
import json
import os
import pathlib
import re
import sqlite3

DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nvram_store.db")
DEFAULTS_PATH = pathlib.Path(__file__).with_name("nvram_defaults.json")


def load_defaults():
    with DEFAULTS_PATH.open(encoding="utf-8") as source:
        return json.load(source)

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
            # Add newly discovered defaults without overwriting user state.
            cursor = conn.cursor()
            for key, value in load_defaults().items():
                cursor.execute(
                    "INSERT OR IGNORE INTO nvram (key, value) VALUES (?, ?)",
                    (key, value),
                )
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
        target = pathlib.Path(target_dir)
        keys_dir = target / "nv-config" / "keys"
        keys_dir.mkdir(parents=True, exist_ok=True)
        store = self.dump()
        for key, value in sorted(store.items()):
            if not re.fullmatch(r"[A-Za-z0-9_]+", key):
                raise ValueError(f"unsafe NVRAM key for sysfs export: {key!r}")
            (keys_dir / key).write_text(f"{value}\n", encoding="utf-8")
        (target / "nv-config" / "add").touch()
        (target / "nv-config" / "commit").touch()
        print(f"[NVRAM] Seeded sysfs tree at {target} with {len(store)} keys.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mazda CMU Mock NVRAM Manager")
    parser.add_argument("--get", help="Get value for NVRAM key")
    parser.add_argument("--set", nargs=2, metavar=("KEY", "VAL"), help="Set value for NVRAM key")
    parser.add_argument("--dump", action="store_true", help="Dump all NVRAM key-value pairs")
    parser.add_argument("--seed-sysfs", metavar="DIR", help="Export NVRAM sysfs directory structure")
    parser.add_argument("--db", default=DEFAULT_DB, help="SQLite backing store path")
    args = parser.parse_args()

    nvram = NVRAMShim(args.db)
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
