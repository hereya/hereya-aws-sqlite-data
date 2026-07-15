// User-data is deliberately thin: fetch the artifact, install runtime pieces,
// write env + systemd unit, start. The strict restore-then-serve boot order
// lives in the SERVICE (tested TypeScript), not in shell.
export interface UserDataParams {
  awsRegion: string;
  artifactParamName: string; // SSM parameter holding the artifact's S3 URI
  artifactHash: string; // content hash of the artifact — see the comment in the script
  serviceEnv: Record<string, string>; // written to /etc/dilaya/data-api.env
}

export function buildUserData(params: UserDataParams): string {
  const envFile = Object.entries(params.serviceEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  return `#!/bin/bash
# service-artifact-hash: ${params.artifactHash}
# (inert, but load-bearing: a new artifact changes this line, which versions the
# launch template and makes the ASG's rolling update replace the instance — so a
# deploy actually rolls the service. Without it the SSM pointer updates and the
# running instance keeps serving the old artifact.)
set -euo pipefail
exec > >(tee /var/log/dilaya-bootstrap.log) 2>&1
echo "dilaya-data-api bootstrap starting"

# --- users & dirs -----------------------------------------------------------
id -u dataapi &>/dev/null || useradd --system --home-dir /opt/dilaya --shell /sbin/nologin dataapi
mkdir -p /opt/dilaya /var/lib/dilaya/dbs /etc/dilaya

# --- fetch artifact (pointer lives in SSM so service-only updates skip CDK) --
ARTIFACT_URI=""
for i in $(seq 1 30); do
  ARTIFACT_URI=$(aws ssm get-parameter --region ${params.awsRegion} --name "${params.artifactParamName}" --query Parameter.Value --output text) && break
  echo "ssm get-parameter attempt $i failed; retrying"; sleep 5
done
[ -n "$ARTIFACT_URI" ] || { echo "FATAL: could not resolve artifact URI"; exit 1; }

for i in $(seq 1 30); do
  aws s3 cp --region ${params.awsRegion} "$ARTIFACT_URI" /opt/dilaya/service.tar.gz && break
  echo "s3 cp attempt $i failed; retrying"; sleep 5
done
[ -s /opt/dilaya/service.tar.gz ] || { echo "FATAL: artifact download failed"; exit 1; }

rm -rf /opt/dilaya/service && mkdir -p /opt/dilaya/service
tar -xzf /opt/dilaya/service.tar.gz -C /opt/dilaya/service

# --- runtime pieces (bundled in the artifact — no external network at boot) --
rm -rf /opt/dilaya/node && mkdir -p /opt/dilaya/node
tar -xJf /opt/dilaya/service/node.tar.xz -C /opt/dilaya/node --strip-components=1
install -m 0755 /opt/dilaya/service/bin/litestream /usr/local/bin/litestream

# --- service configuration ---------------------------------------------------
cat > /etc/dilaya/data-api.env <<'ENVEOF'
${envFile}
ENVEOF

chown -R dataapi:dataapi /opt/dilaya /var/lib/dilaya /etc/dilaya

# --- systemd unit: fast local restart net (before the ASG's slower one) ------
cat > /etc/systemd/system/dilaya-data-api.service <<'UNITEOF'
[Unit]
Description=Dilaya SQLite Data API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dataapi
EnvironmentFile=/etc/dilaya/data-api.env
ExecStart=/opt/dilaya/node/bin/node /opt/dilaya/service/main.js
Restart=always
RestartSec=1
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now dilaya-data-api.service
echo "dilaya-data-api bootstrap complete"
`;
}
