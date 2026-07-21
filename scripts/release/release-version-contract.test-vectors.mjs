export const VALID_WINDOWS_RELEASE_VERSIONS = Object.freeze([
  "0.1.0",
  "0.1.0-rc.11",
  "1.2.3-alpha",
  "65535.65535.65535-ci.65535",
]);

export const INVALID_WINDOWS_RELEASE_VERSIONS = Object.freeze([
  "",
  "v0.1.0",
  "0.1.01",
  "0.1.0-rc.01",
  "0.1.0-rc8",
  "0.1.0-alpha.beta",
  "0.1.0-rc.65536",
  "65536.1.1",
  "0.1.0+build.1",
  " 0.1.0",
]);
