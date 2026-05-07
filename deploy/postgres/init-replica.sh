#!/bin/bash
# Initial setup for streaming replication. Runs once when the primary
# Postgres container is first created (postgres image runs every script
# under /docker-entrypoint-initdb.d on the empty data directory).
#
# Creates the replication role + grants. The replica container runs
# pg_basebackup against this role on its first boot.
#
# Network exposure: we restrict pg_hba.conf to the RFC 1918 ranges that
# docker compose networks live in (`172.16.0.0/12` is the default bridge
# network space; `10.0.0.0/8` covers swarm/k8s overlays). NEVER widen this
# to `0.0.0.0/0` — port 5432 of `postgres-primary` should not be published
# to the host, but if it ever is, this CIDR is the last line of defense.
#
# Auth uses SCRAM-SHA-256 (Postgres 14+ default). MD5 is deprecated and
# vulnerable to offline cracking once a hash is leaked.

set -e

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  SET password_encryption = 'scram-sha-256';
  CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '$POSTGRES_REPLICATION_PASSWORD';
EOSQL

cat <<EOF >> "$PGDATA/pg_hba.conf"
# Streaming replication — restricted to docker compose private networks.
host replication replicator 172.16.0.0/12 scram-sha-256
host replication replicator 10.0.0.0/8    scram-sha-256
host replication replicator 192.168.0.0/16 scram-sha-256
EOF
