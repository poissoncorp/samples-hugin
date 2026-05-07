# Hugin master-image runbook

End state: a single `hugin-shrunk.img.gz` you can flash onto fresh 32 GB SD cards
via Raspberry Pi Imager. Every Pi flashed from this image broadcasts AP `Hugin
(ravendb)` and serves the captive portal within ~2 min of first boot.

Read [the plan's Phase 7](#) section before starting if you haven't yet.

## 0. Prerequisites
- Pi is at the desired runtime state. Phases 1–5 of the plan must be applied
  and verified. Phase 6 (zram) is optional.
- Windows host with WSL2 Ubuntu installed.
- SD card reader on the host.
- ~50 GB free on `D:\` for the raw + shrunk images.

## 1. Pre-flight on the Pi (still has dev tooling)
SSH in and confirm:
```bash
sudo systemctl is-active hugin ravendb ollama nginx hugin-warmup
df -h /                                  # ≥ 1.5 GB free
cat /var/lib/hugin/known-networks.json   # should NOT exist
journalctl -b | grep -iE 'fail|error' | head
```
After this point the next step is irreversible *for this image*.

## 2. Final-second strip
Last shell session on the Pi before halt. Each removal one-way:

```bash
# 2a. Backend admin tier (if deployed)
sudo rm -f /usr/lib/hugin/backend/admin-*.js
sudo systemctl restart hugin
journalctl -u hugin -n 5 | grep '\[admin\]'   # expect: 0/N modules loaded (sealed image)

# 2b. Dev tooling — drop tools/ entirely; prod_tools/ stays
sudo rm -rf /usr/lib/hugin/tools

# 2c. Personal artifacts
sudo truncate -s 0 /home/rdb/.bash_history /root/.bash_history
rm -f /home/rdb/.viminfo /home/rdb/.lesshst /home/rdb/.python_history

# 2d. Deploy SSH key (Pi loses dev SSH access here)
sudo sed -i.bak '/gracjan-deploy/d' /home/rdb/.ssh/authorized_keys
sudo rm /home/rdb/.ssh/authorized_keys.bak

# 2e. Final journal vacuum so the image doesn't ship the strip session
sudo journalctl --rotate
sudo journalctl --vacuum-time=1s

# 2f. Halt cleanly. Wait for the green LED to stop blinking before pulling the SD.
sudo shutdown -h now
```

## 3. Read the SD via WSL `dd`
1. Insert the SD into the host. Cancel any "format / initialize" prompt
   Windows pops up.
2. PowerShell (admin):
   ```powershell
   Get-Disk
   ```
   Match by **size = 32 GB** and **bus type = USB**. Note the disk number.
   **Wrong number → clobbered laptop.**
3. Bare-mount the device into WSL:
   ```powershell
   wsl --mount \\.\PHYSICALDRIVE<N> --bare
   ```
4. WSL Ubuntu:
   ```bash
   lsblk            # confirm new /dev/sdX appears with no mount points + size matches
   sudo dd if=/dev/sdX of=/mnt/d/hugin-backup/images/hugin-raw.img \
            bs=4M conv=fsync status=progress
   ```
   ~10–30 min depending on reader speed. Result ≈ 32 GB.
5. Unmount:
   ```powershell
   wsl --unmount \\.\PHYSICALDRIVE<N>
   ```

## 4. Shrink + compress
WSL Ubuntu:
```bash
sudo apt-get install -y parted gzip pv
curl -L https://raw.githubusercontent.com/Drewsif/PiShrink/master/pishrink.sh \
    -o pishrink.sh
chmod +x pishrink.sh
sudo ./pishrink.sh -avZ \
    /mnt/d/hugin-backup/images/hugin-raw.img \
    /mnt/d/hugin-backup/images/hugin-shrunk.img.gz
```
PiShrink shrinks the rootfs to its minimum, repackages, gzips. Patches boot
scripts so the rootfs auto-grows on the first boot of clones. Expected output:
6–10 GB compressed.

## 5. Test flash
1. Raspberry Pi Imager → "Use custom image" → `hugin-shrunk.img.gz` →
   flash to a *new* SD card.
2. Boot a Pi with the new card. **First boot does a partition resize + reboot
   — expect ~2 min before AP broadcasts.** Don't mistake a clone for broken
   in the first minute.
3. Connect a Linux/WSL/macOS client to the AP. From the client, run
   `tools/captive-test.sh`. Expect 12/12 PASS.

## 6. Distribute
Once one clone boots clean, the `.img.gz` is the headcrab. File copy to
Drive / S3 / USB. No per-Pi work after this.

## What's intentionally not in the image
- The temp deploy SSH key (removed in step 2d).
- The on-Pi `/usr/lib/hugin/tools/` directory (removed in 2b).
- Backend admin tier modules (removed in 2a).
- Per-Pi `/var/lib/hugin/known-networks.json` — empty.
- The dev box's `~/.ssh/id_ed25519_hugin` — never on the Pi.
- Wandering `*.corrupted-*` backups, `/tmp/staging-*` — Phase 4 swept.
