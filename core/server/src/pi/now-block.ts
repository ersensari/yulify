/**
 * The date and time, ahead of what the person wrote. Neither pi nor the portal told the model what day it is, so
 * "this week" on a calendar was guessed (a June week was searched in October, 2026-10-19). Folded away on the page
 * like the other context blocks (web/src/context-blocks.ts).
 */
const ZONE = process.env.PORTAL_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

export function nowText(date = new Date(), timeZone = ZONE): string {
  const when = new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone, timeZoneName: "longOffset",
  }).format(date);
  return `${when} (${timeZone})`;
}

/** A command ("/compact", "/model ...") is left as it is: the block would stop it being one. */
export function withNow(message: string, date = new Date(), timeZone = ZONE): string {
  if (message.trimStart().startsWith("/")) return message;
  return `<now>${nowText(date, timeZone)}</now>\n\n${message}`;
}
