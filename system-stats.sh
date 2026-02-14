#!/bin/bash
# Collects system stats and writes to /tmp/system_stats.json every 5 seconds
OUTPUT="/tmp/system_stats.json"

# Get initial CPU stats for delta calculation
read_cpu_stats() {
    awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5}' /proc/stat
}

prev_stats=$(read_cpu_stats)
prev_total=$(echo "$prev_stats" | awk '{print $1}')
prev_idle=$(echo "$prev_stats" | awk '{print $2}')

# Get initial network stats
declare -A prev_rx prev_tx
for iface in eno1 tailscale0; do
    if [ -f "/sys/class/net/$iface/statistics/rx_bytes" ]; then
        prev_rx[$iface]=$(cat /sys/class/net/$iface/statistics/rx_bytes)
        prev_tx[$iface]=$(cat /sys/class/net/$iface/statistics/tx_bytes)
    fi
done
prev_time=$(date +%s%N)

sleep 1

while true; do
    # CPU usage (delta)
    curr_stats=$(read_cpu_stats)
    curr_total=$(echo "$curr_stats" | awk '{print $1}')
    curr_idle=$(echo "$curr_stats" | awk '{print $2}')
    delta_total=$((curr_total - prev_total))
    delta_idle=$((curr_idle - prev_idle))
    if [ "$delta_total" -gt 0 ]; then
        cpu_pct=$(awk "BEGIN {printf \"%.1f\", (1 - $delta_idle/$delta_total) * 100}")
    else
        cpu_pct="0.0"
    fi
    prev_total=$curr_total
    prev_idle=$curr_idle

    # Load average
    read load1 load5 load15 _ _ < /proc/loadavg
    cores=$(nproc)

    # RAM
    read -r mem_total mem_avail mem_free buffers cached swap_total swap_free < <(
        awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} /^SwapTotal:/{st=$2} /^SwapFree:/{sf=$2} END{print t, a, f, b, c, st, sf}' /proc/meminfo
    )
    mem_used=$((mem_total - mem_avail))
    swap_used=$((swap_total - swap_free))

    # Disk (root mount)
    read disk_total disk_used disk_avail disk_pct < <(df -BG / | awk 'NR==2 {gsub("G",""); print $2, $3, $4, int($5)}')

    # Network throughput
    curr_time=$(date +%s%N)
    elapsed_ns=$((curr_time - prev_time))
    elapsed_s=$(awk "BEGIN {printf \"%.3f\", $elapsed_ns/1000000000}")
    
    net_json="{"
    first=1
    for iface in eno1 tailscale0; do
        if [ -f "/sys/class/net/$iface/statistics/rx_bytes" ]; then
            curr_rx=$(cat /sys/class/net/$iface/statistics/rx_bytes)
            curr_tx=$(cat /sys/class/net/$iface/statistics/tx_bytes)
            if [ -n "${prev_rx[$iface]}" ]; then
                rx_rate=$(awk "BEGIN {printf \"%.0f\", ($curr_rx - ${prev_rx[$iface]}) / $elapsed_s}")
                tx_rate=$(awk "BEGIN {printf \"%.0f\", ($curr_tx - ${prev_tx[$iface]}) / $elapsed_s}")
            else
                rx_rate=0; tx_rate=0
            fi
            prev_rx[$iface]=$curr_rx
            prev_tx[$iface]=$curr_tx
            [ $first -eq 0 ] && net_json+=","
            net_json+="\"$iface\":{\"rx_bytes_sec\":$rx_rate,\"tx_bytes_sec\":$tx_rate}"
            first=0
        fi
    done
    net_json+="}"
    prev_time=$curr_time

    # Uptime
    uptime_secs=$(awk '{print int($1)}' /proc/uptime)

    cat > "$OUTPUT.tmp" <<EOF
{
  "cpu": {
    "usage_pct": $cpu_pct,
    "load_1": $load1,
    "load_5": $load5,
    "load_15": $load15,
    "cores": $cores
  },
  "ram": {
    "total_kb": $mem_total,
    "used_kb": $mem_used,
    "available_kb": $mem_avail
  },
  "swap": {
    "total_kb": $swap_total,
    "used_kb": $swap_used
  },
  "disk": {
    "total_gb": $disk_total,
    "used_gb": $disk_used,
    "available_gb": $disk_avail,
    "usage_pct": $disk_pct
  },
  "network": $net_json,
  "uptime_secs": $uptime_secs,
  "timestamp": $(date +%s)
}
EOF
    cat "$OUTPUT.tmp" > "$OUTPUT"
    sleep 5
done
