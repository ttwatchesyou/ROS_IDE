# ROS Sim Cluster

The existing Master remains a ROS Sim host. Its existing `SIM-*` workspaces and
behavior remain on Master. A new Ubuntu Worker is an additional placement for
`SIM-C<cluster-id>-*` workspaces. The existing website URL and login remain the
entry point. Master owns users, Cluster memberships, robot records, session
permissions, and capacity leases. A Cluster admin may create and manage users
for that Cluster. Only a Master admin may create Clusters, set limits, assign a
Cluster admin, or rotate a Worker secret.

Run a single Master process for this version. Its in-memory Sim sessions and
leases are cleared on restart; multiple active Master replicas are not yet
supported.

## Prepare Master

1. Back up the workspace and database before deploying. The migration in
   `ensureClusterSchema` runs at Master startup; `schema.sql` also describes the
   new tables.
2. Deploy Master, then open `/cluster-admin` at the same web origin as the
   robot selector. Create a Worker, set `max_users` and `max_sims`, and save
   the one-time secret. Create a Cluster admin account in that Cluster.
3. Build the Worker executable on an Ubuntu machine with the **same CPU
   architecture** as the target: `npm run build:cluster-worker`. The output is
   `dist/roside-cluster-worker`. Install only that executable on the Worker.
   Do not transfer the Master repository, `.env`, or database credentials.

## Prepare each Ubuntu Worker

Install the same compatible ROS 2 distribution and build dependencies as the
Master's Sim. Create a dedicated unprivileged OS account for this Worker. Mount
only this Cluster's Master workspace directory
`<master-repo>/sim_ws/CL-<id>` at a dedicated writable path on the Worker,
for example `/srv/roside-cluster/workspaces`. Use a private LAN or VPN with a
protected NFS/SSHFS share. Do not share the Master repository or another
Cluster's workspace. Verify the mount is writable and persists after reboot.

The Admin page's **ติดตั้ง Worker** tab downloads `roside-cluster-worker`,
`config.json`, and `install.sh`. It only offers `config.json` while the new
secret is visible after Cluster creation or rotation. Keep the three files in
one directory on the Worker. Create a writable mount first, then run
`sudo bash install.sh`. The installer checks the mount and permissions, creates
an unprivileged `roside-cluster` account, installs the executable and config,
and enables the systemd service. The config is stored with mode `0600`.

The generated `config.json` contains:

```json
{
  "master_url": "wss://your-existing-web-host",
  "cluster_key": "CL-key-shown-in-admin",
  "cluster_secret": "one-time-secret-shown-in-admin",
  "workspace_root": "/srv/roside-cluster/workspaces"
}
```

Use a trusted TLS certificate on the existing web host, with WebSocket upgrade
for `/ws/cluster`. `ws://` is accepted only for loopback development. Keep the
secret out of shell history and logs. A rotated secret disconnects the Worker;
replace the config and restart it.

Install the executable at `/usr/local/bin/roside-cluster-worker` and create a
systemd service similar to:

```ini
[Unit]
Description=ROSIDE Cluster Worker
After=network-online.target remote-fs.target
Wants=network-online.target
RequiresMountsFor=/srv/roside-cluster/workspaces

[Service]
Type=simple
User=roside-cluster
Environment=ROSIDE_CLUSTER_CONFIG=/etc/roside-cluster/config.json
ExecStart=/usr/local/bin/roside-cluster-worker
Restart=always
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

After the service connects, `/cluster-admin` shows the Worker as online. Add a
Sim from the robot selector and choose the Worker. The Master capacity lease
limits simultaneously running Sim instances; the registered Sim count can be
larger. When the Worker disconnects, Master closes its affected IDE sessions.

## Source protection and isolation limits

The Worker package contains only the Worker runtime, not the Master web source
or database. Each Worker mount contains only that Cluster's workspaces. A
person with root on the Worker can inspect or copy anything the Worker can
execute or read, including generated user Sim files and the executable. A
binary is not a guarantee against reverse engineering. Use separate OS
accounts or containers per user if users within one Cluster must be isolated
from one another; this version isolates Clusters by separate Workers/mounts and
limits access through the Master web API.

No Worker has been commissioned until its Ubuntu host, private mount, TLS URL,
and credentials have been configured and an end-to-end ROS Sim run succeeds.
