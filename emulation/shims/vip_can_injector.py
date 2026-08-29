#!/usr/bin/env python3
"""
Stage 4: VIP / CAN Signal Playback & Event Injector
Sends simulated vehicle signals (speed, gear, ignition, commander controls) to CMU HMI.
"""

import sys
import time
import json
import argparse
import asyncio

try:
    import websockets
except ImportError:
    websockets = None

DEFAULT_WS_URL = "ws://127.0.0.1:2700"

SCENARIOS = {
    "startup": [
        {"action": "ignition", "state": "ON", "delay": 0.5},
        {"action": "event", "uiaId": "system", "eventId": "Global.InitGui", "delay": 1.0},
        {"action": "event", "uiaId": "system", "eventId": "SelectApplications", "delay": 2.0}
    ],
    "drive_mode": [
        {"action": "gear", "state": "DRIVE", "delay": 0.5},
        {"action": "speed", "val": 35, "delay": 1.0},
        {"action": "speed", "val": 65, "delay": 2.0}
    ],
    "commander_nav": [
        {"action": "commander", "key": "cw", "delay": 0.5},
        {"action": "commander", "key": "cw", "delay": 0.5},
        {"action": "commander", "key": "select", "delay": 1.0}
    ]
}

async def send_msg(url, data):
    if websockets is None:
        print("[INJECTOR] Warning: Python 'websockets' module not installed.")
        print(f"[INJECTOR] Simulated message to {url}: {json.dumps(data)}")
        return

    try:
        async with websockets.connect(url) as ws:
            payload = json.dumps(data)
            await ws.send(payload)
            print(f"[INJECTOR] Sent to {url}: {payload}")
    except Exception as e:
        print(f"[INJECTOR] Connection error to {url}: {e}")

async def run_scenario(scenario_name, ws_url):
    steps = SCENARIOS.get(scenario_name)
    if not steps:
        print(f"[INJECTOR] Unknown scenario '{scenario_name}'. Available: {list(SCENARIOS.keys())}")
        return

    print(f"[INJECTOR] Running scenario '{scenario_name}' against {ws_url}...")
    for step in steps:
        await asyncio.sleep(step.get("delay", 0.5))
        act = step["action"]
        if act == "event":
            await send_msg(ws_url, {"msgType": "event", "uiaId": step["uiaId"], "eventId": step["eventId"], "params": "{}"})
        elif act == "commander":
            await send_msg(ws_url, {"msgType": "event", "uiaId": "common", "eventId": f"Multicontroller.{step['key']}", "params": "{}"})
        else:
            await send_msg(ws_url, {"msgType": "msg", "uiaId": "vehsettings", "msgId": step["action"], "params": step})

def main():
    parser = argparse.ArgumentParser(description="Mazda CMU VIP/CAN Signal Injector")
    parser.add_argument("--scenario", choices=list(SCENARIOS.keys()), default="startup", help="Scenario to execute")
    parser.add_argument("--url", default=DEFAULT_WS_URL, help="Target WebSocket URL")
    args = parser.parse_args()

    asyncio.run(run_scenario(args.scenario, args.url))

if __name__ == "__main__":
    main()
