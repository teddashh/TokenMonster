import type { Clock } from "@tokenmonster/api-domain";

export class CloudflareClock implements Clock {
  now(): Date {
    return new Date();
  }
}
