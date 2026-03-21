#!/usr/bin/env bash
# Run this on the Proxmox host shell (root@az-lab.az-lab.dev)
# Creates VM 108: nemoclaw-01 — Ubuntu 22.04, 4 vCPU, 16GB RAM, 40GB disk
# VLAN10 (Main LAN), IP 192.168.1.183

set -euo pipefail

VM_ID=108
VM_NAME="nemoclaw-01"
STORAGE="nvme-fast"
BRIDGE="vmbr0"
VLAN_TAG=10
IP="192.168.1.183/24"
GW="192.168.1.1"
DNS="192.168.99.2"
CORES=4
MEMORY=16384  # MB
DISK_SIZE=40  # GB
UBUNTU_IMG="jammy-server-cloudimg-amd64.img"
UBUNTU_URL="https://cloud-images.ubuntu.com/jammy/current/${UBUNTU_IMG}"

# SSH keys — Claude Desktop + svc-podman-01
SSH_KEYS='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINKleS7coCvh1qfnC7uf9ATNY39oS63jqGNLWfqbq0FI claude-desktop@az-lab
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMhuidEH1xKSJyNgnlcoTrxq9rPJZ+BMOPll6+7FKlZe svc-podman-01'

echo "=== NemoClaw VM Setup ==="
echo "VM ID:     $VM_ID"
echo "Name:      $VM_NAME"
echo "Storage:   $STORAGE"
echo "IP:        $IP"
echo "Resources: ${CORES} vCPU, ${MEMORY}MB RAM, ${DISK_SIZE}GB disk"
echo ""

# Download Ubuntu cloud image if not cached
IMG_PATH="/var/lib/vz/template/iso/${UBUNTU_IMG}"
if [ ! -f "$IMG_PATH" ]; then
    echo "Downloading Ubuntu 22.04 cloud image..."
    wget -q --show-progress -O "$IMG_PATH" "$UBUNTU_URL"
else
    echo "Ubuntu cloud image already cached."
fi

# Write SSH keys to temp file
SSHKEY_FILE=$(mktemp)
echo "$SSH_KEYS" > "$SSHKEY_FILE"

# Create VM
echo "Creating VM $VM_ID..."
qm create "$VM_ID" \
  --name "$VM_NAME" \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --net0 "virtio,bridge=${BRIDGE},tag=${VLAN_TAG}" \
  --serial0 socket \
  --vga serial0 \
  --agent enabled=1 \
  --ostype l26 \
  --cpu host \
  --bios ovmf \
  --machine q35 \
  --efidisk0 "${STORAGE}:1,efitype=4m,pre-enrolled-keys=0"

# Import cloud image as disk
echo "Importing disk..."
qm importdisk "$VM_ID" "$IMG_PATH" "$STORAGE" --format qcow2
qm set "$VM_ID" \
  --scsihw virtio-scsi-pci \
  --scsi0 "${STORAGE}:vm-${VM_ID}-disk-1,discard=on,ssd=1" \
  --boot order=scsi0

# Resize to desired size
qm resize "$VM_ID" scsi0 "${DISK_SIZE}G"

# Cloud-init drive
qm set "$VM_ID" \
  --ide2 "${STORAGE}:cloudinit" \
  --cicustom "" \
  --ciuser ubuntu \
  --sshkeys "$SSHKEY_FILE" \
  --ipconfig0 "ip=${IP},gw=${GW}" \
  --nameserver "$DNS" \
  --searchdomain "az-lab.dev"

rm -f "$SSHKEY_FILE"

# Start it
echo "Starting VM..."
qm start "$VM_ID"

echo ""
echo "=== Done ==="
echo "VM $VM_ID ($VM_NAME) starting at 192.168.1.183"
echo "SSH in ~60s: ssh ubuntu@192.168.1.183"
echo ""
echo "After boot, run the NemoClaw setup:"
echo "  ssh ubuntu@192.168.1.183 'bash /tmp/nemoclaw-setup.sh'"
