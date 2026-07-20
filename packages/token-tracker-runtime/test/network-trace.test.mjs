import { describe, expect, it } from "vitest";

import { inspectLoopbackNetworkTrace } from "../../../scripts/release/assert-loopback-network-trace.mjs";

const safeTrace = [
  "10 socket(AF_INET, SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK, IPPROTO_IP) = 21",
  '10 bind(21, {sa_family=AF_INET, sin_port=htons(7680), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
  "11 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 22",
  '11 connect(22, {sa_family=AF_INET, sin_port=htons(7680), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 EINPROGRESS',
  "10 socket(AF_INET, SOCK_DGRAM|SOCK_CLOEXEC, IPPROTO_UDP) = 24",
  '10 bind(24, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
  "12 socket(AF_UNIX, SOCK_STREAM|SOCK_CLOEXEC, 0) = 25",
  "12 socketpair(AF_UNIX, SOCK_STREAM, 0, [3, 4]) = 0",
].join("\n");

describe("installed release network-trace verifier", () => {
  it("accepts the two local listeners and their managed readiness connection", () => {
    expect(inspectLoopbackNetworkTrace(safeTrace)).toEqual({
      loopbackBinds: 2,
      loopbackConnects: 1,
    });
  });

  it.each([
    '10 connect(22, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("1.1.1.1")}, 16) = 0',
    '10 sendto(22, "dns", 3, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("8.8.8.8")}, 16) = 3',
    '10 connect(22, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "::ffff:1.1.1.1", &sin6_addr)}, 28) = 0',
    "10 connect(22, 0x7ff00000, 16) = 0",
    '10 sendmsg(22, {msg_name=NULL}, 0) = 3',
    '10 send(22, "opaque", 6, 0) = 6',
    "10 socket(AF_PACKET, SOCK_RAW, 0) = 22",
    "10 socket(AF_INET, SOCK_RAW, IPPROTO_RAW) = 22",
    "10 socket(AF_INET, SOCK_DGRAM, IPPROTO_ICMP) = 22",
    "10 socket(AF_NETLINK, SOCK_RAW|SOCK_CLOEXEC, NETLINK_ROUTE) = 22",
    "10 socket(AF_INET, SOCK_STREAM|SOCK_CLOEXEC|SOCK_CLOEXEC, IPPROTO_TCP) = 22",
    "10 socket(AF_INET, SOCK_STREAM, 0x6) = 22",
  ])("rejects external or opaque egress: %s", (unsafeLine) => {
    expect(() =>
      inspectLoopbackNetworkTrace(`${safeTrace}\n${unsafeLine}`),
    ).toThrow(/rejected/u);
  });
});
