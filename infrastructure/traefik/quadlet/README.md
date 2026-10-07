# Traefik — socket-activated quadlet (live since 2026-10-07)

**Why:** under rootless podman 4.9.3, ports published via `rootlessport` reach
Traefik with source IP = its own bridge IP (10.89.0.6). Every `ipAllowList`
(lan-allow) saw 10.89.0.6 and admitted everyone, including the internet via the
WAN 443/80 forwards. Here systemd owns :80/:443 in the host netns and passes the
fds in (`FileDescriptorName` = entrypoint name, Traefik >= 3.1), so the access
log shows real client IPs. The container stays on the `proxy` bridge for backend DNS.

Container->Traefik calls through the host IP show up as `192.168.1.181`.

## Install
    cp traefik.container ~/.config/containers/systemd/
    cp traefik-http.socket traefik-https.socket ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user disable --now compose-stack@traefik.service
    systemctl --user enable --now traefik-http.socket traefik-https.socket
    systemctl --user start traefik.service

`../compose.yml` is kept unchanged as the rollback path. Keep the Exec/Label
blocks in `traefik.container` in sync with it (image tag, aliasheadersstrategy, etc.).

## Rollback
    systemctl --user disable --now traefik-http.socket traefik-https.socket
    systemctl --user stop traefik.service
    systemctl --user enable --now compose-stack@traefik.service
Then re-add `10.89.0.0/16` to `../dynamic/lan-middlewares.yml`, because rootlessport hides client IPs again.
