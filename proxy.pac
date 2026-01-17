function FindProxyForURL(url, host) {
    if (isPlainHostName(host) || 
        shExpMatch(host, "*.local") || 
        isInNet(dnsResolve(host), "127.0.0.0", "255.0.0.0") ||
        isInNet(dnsResolve(host), "192.168.0.0", "255.255.0.0") ||
        isInNet(dnsResolve(host), "10.0.0.0", "255.0.0.0")) {
        return "DIRECT";
    }

    return "PROXY 42.118.237.5:8080; DIRECT";
}
