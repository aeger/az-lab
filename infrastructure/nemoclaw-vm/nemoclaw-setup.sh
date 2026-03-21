#!/usr/bin/env bash
# Run inside the nemoclaw-01 VM after first boot (as ubuntu user)
# Installs Docker, Node.js 22, NemoClaw, and configures for free Nemotron inference

set -euo pipefail

echo "=== NemoClaw VM Bootstrap ==="

# System update
sudo apt-get update -qq && sudo apt-get upgrade -y -qq

# Install Docker (official repo)
echo "Installing Docker..."
sudo apt-get install -y -qq ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update -qq
sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker ubuntu
echo "Docker installed."

# Install Node.js 22 via NodeSource
echo "Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - -s -- -y
sudo apt-get install -y -qq nodejs
echo "Node.js $(node --version) installed."

# Install NemoClaw
echo "Installing NemoClaw..."
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
echo "NemoClaw installed."

# Verify
echo ""
echo "=== Verification ==="
docker --version
node --version
nemoclaw --version 2>/dev/null || echo "nemoclaw: check PATH (may need new shell)"
echo ""
echo "=== Done ==="
echo "Next: run 'nemoclaw onboard' to configure with free Nemotron inference"
echo "Get a free API key at: https://build.nvidia.com"
