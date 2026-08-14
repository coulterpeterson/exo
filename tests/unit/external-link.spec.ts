/**
 * The gate in front of shell.openExternal.
 *
 * Anyone who can email you can put a link in front of this function, and
 * whatever gets through is handed to the OS to launch. So the interesting cases
 * are not the happy ones — they are the strings that look like http to a
 * prefix check and are something else to the operating system.
 */
import { test, expect } from "@playwright/test";
import { isOpenableExternalUrl } from "../../src/main/utils/external-link";

test.describe("isOpenableExternalUrl", () => {
  test("allows ordinary web links", () => {
    expect(isOpenableExternalUrl("https://example.com/q3-report")).toBe(true);
    expect(isOpenableExternalUrl("http://example.com")).toBe(true);
    expect(isOpenableExternalUrl("https://example.com:8443/a?b=c#d")).toBe(true);
  });

  test("allows mailto, since composing is a reasonable thing for a link to do", () => {
    expect(isOpenableExternalUrl("mailto:someone@example.com?subject=hi")).toBe(true);
  });

  test("refuses schemes that launch something other than a browser", () => {
    // The reason this function exists: openExternal will start whatever
    // application has registered the scheme.
    expect(isOpenableExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableExternalUrl("ms-msdt:/id")).toBe(false);
    expect(isOpenableExternalUrl("vscode://file/etc/passwd")).toBe(false);
    expect(isOpenableExternalUrl("smb://host/share")).toBe(false);
  });

  test("is not fooled by strings a prefix check would accept", () => {
    // "https:/evil" parses with protocol "https:" only if it is really https —
    // these are the shapes that make startsWith("http") the wrong tool.
    expect(isOpenableExternalUrl(" javascript:alert(1)")).toBe(false);
    expect(isOpenableExternalUrl("java\tscript:alert(1)")).toBe(false);
    expect(isOpenableExternalUrl("httpx://example.com")).toBe(false);
    expect(isOpenableExternalUrl("not-http://example.com")).toBe(false);
  });

  test("refuses anything that is not a URL at all", () => {
    expect(isOpenableExternalUrl("")).toBe(false);
    expect(isOpenableExternalUrl("example.com")).toBe(false);
    expect(isOpenableExternalUrl("//example.com")).toBe(false);
  });

  test("protocol matching is case-insensitive, as the URL parser normalises it", () => {
    expect(isOpenableExternalUrl("HTTPS://example.com")).toBe(true);
    expect(isOpenableExternalUrl("JavaScript:alert(1)")).toBe(false);
  });
});
