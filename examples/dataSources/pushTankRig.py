#!/usr/bin/env python3
# Copyright © 2026 Zenin Easa Panthakkalakath
"""The simulated lab rig, sending its readings to Konjugate's push service as it takes them.

The same pretend rig as simulatedTankRig.py (a heated water tank, an operator switching the heater, a thermometer), but instead of
appending to a log file it sends each reading to Konjugate over the network, as a lab script with nowhere else to put its numbers
would (docs/connectingADataSource.md, "Taking readings a script sends"). It is also the push service's demonstration: run it on
another computer, or on the same one, and a live twin of examples/dataSources/simulatedTankRig.kjt follows the tank.

In Konjugate: Connections (⇄ in the title bar), tick "On the network", Start, make a key that may send heaterPower and
tankTemperature, and save the certificate. Then, wherever this script runs:

    python3 examples/dataSources/pushTankRig.py https://192.168.1.8:8737 --key kjp_... --certificate konjugate-push.pem --speed 600

The address, the key and the certificate are the ones the Connections panel shows; it shows this very command, filled in. The
certificate is how the script knows it is talking to that Konjugate and no other: the connection is refused if the other end cannot
prove it holds that certificate's key, and nothing is sent in the clear. With the service listening on this computer only, use
http://127.0.0.1:8737 and no certificate.

Only the Python standard library is used, and Python 3.8 or newer is enough.
"""

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simulatedTankRig import TankRig  # noqa: E402  (the same rig, beside this script)


class PushClient:
    """Sends readings to Konjugate's push service: POST /v1/readings, JSON, with the key, over HTTPS when given a certificate."""

    def __init__(self, url, key, certificate=None):
        self.url = url.rstrip("/") + "/v1/readings"
        self.key = key
        self.context = None
        if self.url.startswith("https://"):
            if not certificate:
                raise SystemExit("An https:// address needs the service's certificate (--certificate), so the script knows whom it is talking to.")
            # Trust exactly this certificate, and check it as for any web site: never turn checking off.
            self.context = ssl.create_default_context(cafile=certificate)
        elif certificate:
            raise SystemExit("A certificate is for an https:// address.")

    def send(self, readings):
        """Sends readings, each {signal, value, time, quality}; returns the service's answer, and raises on a refusal."""
        request = urllib.request.Request(
            self.url,
            data=json.dumps({"readings": readings}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.key},
        )
        try:
            with urllib.request.urlopen(request, context=self.context, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # The service says why it refused, in the body.
            answer = json.load(error)
            raise SystemExit("Konjugate refused the readings (%s): %s" % (answer.get("status"), answer.get("reason")))


def main():
    parser = argparse.ArgumentParser(description="The simulated heated-tank rig, sending its readings to Konjugate's push service.")
    parser.add_argument("url", help="the push service's address, as the Connections panel shows it, e.g. https://192.168.1.8:8737")
    parser.add_argument("--key", default=os.environ.get("KONJUGATE_PUSH_KEY"), help="the key made for this script (or set KONJUGATE_PUSH_KEY)")
    parser.add_argument("--certificate", help="the service's certificate, saved from the Connections panel, for an https:// address")
    parser.add_argument("--duration", type=float, default=21600, help="how long the experiment lasts, in rig seconds (default: six hours)")
    parser.add_argument("--sample", type=float, default=60, help="seconds between thermometer readings (default: 60)")
    parser.add_argument("--speed", type=float, default=1, help="rig seconds per real second: 1 is real time, 600 runs an hour in six seconds")
    parser.add_argument("--start", help="the date and time the experiment starts, with its zone (default: now)")
    parser.add_argument("--seed", type=int, default=1, help="the thermometer noise's seed, so a run can be repeated exactly")
    parser.add_argument("--glitch", type=float, action="append", help="a rig time at which the thermometer glitches (default: 5400)")
    parser.add_argument("--drift", type=float, default=0.0, help="how fast the tank's heat loss grows, as a fraction an hour (default: 0, none)")
    args = parser.parse_args()
    if not args.key:
        raise SystemExit("Give the key made for this script in the Connections panel: --key kjp_... (or set KONJUGATE_PUSH_KEY).")

    client = PushClient(args.url, args.key, args.certificate)
    start = datetime.fromisoformat(args.start.replace("Z", "+00:00")) if args.start else datetime.now(timezone.utc).replace(microsecond=0)
    epoch = start.timestamp()
    rig = TankRig(args.seed, args.glitch if args.glitch is not None else [5400], args.drift)

    # Everything that happens, in time order: each thermometer reading and each time the operator touches the heater.
    readings = [index * args.sample for index in range(int(args.duration // args.sample) + 1)]
    changes = [moment for moment, _ in rig.schedule if moment <= args.duration]
    moments = sorted(set(readings) | set(changes))

    began = time.monotonic()
    now = 0.0
    power = rig.heater_at(0)
    sent = 0
    for moment in moments:
        rig.advance(now, moment - now, power)
        now = moment
        delay = began + moment / args.speed - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        batch = []
        if moment in changes:
            power = rig.heater_at(moment)
            batch.append({"signal": "heaterPower", "value": power, "time": epoch + moment})
        if moment in readings:
            value, quality = rig.read_thermometer(moment)
            batch.append({"signal": "tankTemperature", "value": value, "time": epoch + moment, "quality": quality or "good"})
        sent += client.send(batch)["taken"]
        if sent % 50 < len(batch):
            print("%d readings sent, the tank at %.2f K" % (sent, rig.temperature), flush=True)
    print("Done: %d readings sent to %s." % (sent, args.url))


if __name__ == "__main__":
    main()
