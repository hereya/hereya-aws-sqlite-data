// update-motd's 70-available-updates runs dnf, which loads the repo metadata:
// ~200 MB for 30 s on a 916 MB VM. It was the ONLY dip in MemoryAvailableBytes
// (415 → 219 MB, 5 dips out of 5, 21–25/10, every 21 h 36) and it grows with
// the metadata. Nobody reads this VM's MOTD — access is SSM only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUserData } from "../lib/user-data.ts";

const script = buildUserData({
  awsRegion: "eu-west-1",
  artifactParamName: "/p",
  artifactHash: "h",
  serviceEnv: {},
});

test("user-data masks update-motd.timer (dnf's ~200 MB daily spike)", () => {
  assert.match(script, /^systemctl mask --now update-motd\.timer/m);
});

test("the mask lands BEFORE the service starts (a failure there must not be what aborts the boot)", () => {
  const mask = script.indexOf("systemctl mask --now update-motd.timer");
  const start = script.indexOf("systemctl enable --now dilaya-data-api.service");
  assert.ok(mask > 0 && start > mask);
});
