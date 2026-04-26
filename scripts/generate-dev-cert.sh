#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT_DIR/.local/certs"
KEY_FILE="$CERT_DIR/frontend-dev-key.pem"
CERT_FILE="$CERT_DIR/frontend-dev-cert.pem"
OPENSSL_CONFIG="$CERT_DIR/openssl-dev-cert.cnf"

mkdir -p "$CERT_DIR"

ip_candidates=()
while IFS= read -r ip; do
  if [[ -n "$ip" && "$ip" != 127.* ]]; then
    ip_candidates+=("$ip")
  fi
done < <(ifconfig | awk '/inet / {print $2}')

alt_names=(
  "DNS.1 = localhost"
  "IP.1 = 127.0.0.1"
)

index=2
for ip in "${ip_candidates[@]:-}"; do
  if [[ -z "$ip" ]]; then
    continue
  fi
  alt_names+=("IP.$index = $ip")
  index=$((index + 1))
done

cat > "$OPENSSL_CONFIG" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
x509_extensions = v3_req
distinguished_name = dn

[dn]
C = CN
ST = Shanghai
L = Shanghai
O = Murphy Cookbook Dev
OU = Frontend
CN = localhost

[v3_req]
subjectAltName = @alt_names
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth

[alt_names]
$(printf '%s\n' "${alt_names[@]}")
EOF

openssl req \
  -x509 \
  -nodes \
  -days 3650 \
  -newkey rsa:2048 \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -config "$OPENSSL_CONFIG" >/dev/null 2>&1

echo "Generated HTTPS dev certificate:"
echo "  cert: $CERT_FILE"
echo "  key:  $KEY_FILE"
if [[ ${#ip_candidates[@]} -gt 0 ]]; then
  echo "  LAN IPs: ${ip_candidates[*]}"
else
  echo "  LAN IPs: none detected, certificate only covers localhost and 127.0.0.1"
fi
