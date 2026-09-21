import { afterAll, beforeAll, describe, expect, it } from "vitest";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CanvasService } from "./canvas.service";
import type { Database } from "@veynlo/db";
import type { IngestionService } from "../ingestion/ingestion.service";

/**
 * The Canvas service talking to a real HTTP server.
 *
 * Not a mocked `fetch`. A stubbed fetch only proves the code calls the function it was written to call;
 * a real server proves the requests are actually well formed — that the token travels as a bearer header
 * rather than in a query string where it would land in logs, that a 401 is read as a rejected token
 * rather than an outage, and that one unreadable course does not lose the others.
 *
 * The server speaks real HTTPS, using the same generated localhost certificate the IMAP and CalDAV suites
 * use, because the scheme check is not something to bypass for a test: a Canvas address must be https, and
 * proving the token travels safely means actually putting it through TLS. Run with:
 *
 *   NODE_EXTRA_CA_CERTS=<repo>/.claude/test-certs/localhost-cert.pem npx vitest run src/modules/school/canvas.sync.test.ts
 *
 * The one thing overridden is the host check — `assertHostnameIsPublic` correctly refuses 127.0.0.1, and
 * the refusals are tested against the unmodified service below.
 */
let server: https.Server;
let origin: string;

const seen: { path: string; auth: string | undefined }[] = [];
let selfStatus = 200;

beforeAll(async () => {
  const certDir = path.join(__dirname, "..", "..", "..", "..", "..", ".claude", "test-certs");
  server = https.createServer(
    { key: fs.readFileSync(path.join(certDir, "localhost-key.pem")), cert: fs.readFileSync(path.join(certDir, "localhost-cert.pem")) },
    (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.push({ path: `${url.pathname}${url.search}`, auth: req.headers.authorization });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/v1/users/self") {
      if (selfStatus !== 200) return json(selfStatus, { errors: [{ message: "Invalid access token." }] });
      return json(200, { id: 1, name: "Sam Rivera" });
    }

    if (url.pathname === "/api/v1/courses") {
      return json(200, [
        { id: 12, name: "Algebra II" },
        { id: 13, name: "Biology" },
      ]);
    }

    if (url.pathname === "/api/v1/courses/12/assignments") {
      return json(200, [
        { id: 991, name: "Chapter 4 Questions", due_at: "2026-04-15T23:59:00Z", description: "<p>Show your work.</p>" },
        { id: 992, name: "Extra credit", due_at: null },
      ]);
    }

    // Course 13 is deliberately unreadable — a concluded course, or one whose teacher restricted access,
    // is a normal state and must not lose course 12's work.
    if (url.pathname === "/api/v1/courses/13/assignments") return json(403, { errors: [{ message: "Forbidden" }] });

    if (url.pathname === "/api/v1/announcements") {
      return json(200, [{ id: 55, title: "No class Friday", context_code: "course_12", posted_at: "2026-03-02T15:00:00Z", message: "Long weekend." }]);
    }

    return json(404, {});
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Reaches the local test server, and changes nothing else.
 *
 * `assertHostnameIsPublic` correctly refuses 127.0.0.1, so a real HTTP server on this machine cannot be
 * called through it. Overriding the one host-check method is what makes the sync path testable at all;
 * the guard itself is exercised against the UNMODIFIED service in the refusal block below, so nothing
 * here weakens what production does.
 */
class LocalCanvasService extends CanvasService {
  protected override async assertHostAllowed(hostname: string): Promise<void> {
    if (hostname === "127.0.0.1") return;
    return super.assertHostAllowed(hostname);
  }
}

function service() {
  const filed: Record<string, unknown>[] = [];
  const ingestion = {
    ingestFeedSchoolEvent: async (params: Record<string, unknown>) => {
      filed.push(params);
      return true;
    },
  } as unknown as IngestionService;
  const db = {} as unknown as Database;
  return { canvas: new LocalCanvasService(db, ingestion), filed, real: new CanvasService(db, ingestion) };
}

async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const response = (err as { getResponse?: () => unknown })?.getResponse?.();
    if (response && typeof response === "object" && "code" in response) return String((response as { code: unknown }).code);
    return `UNEXPECTED: ${(err as Error)?.message ?? String(err)}`;
  }
  return "NO_ERROR_THROWN";
}

describe("Canvas refuses an address it should not call", () => {
  it("refuses a loopback address", async () => {
    // The whole reason this connector needs a guard the others do not: the host came from the user.
    // Against the real service — the subclass used elsewhere in this file is precisely what must NOT be
    // able to make this pass.
    const { real } = service();
    expect(await errorCode(() => real.probe("https://127.0.0.1", "tok"))).toBe("URL_UNREACHABLE");
  });

  it("refuses the cloud instance-metadata address", async () => {
    // 169.254.169.254 is the single most valuable target for an SSRF in a hosted deployment.
    const { real } = service();
    expect(await errorCode(() => real.probe("https://169.254.169.254", "tok"))).toBe("URL_UNREACHABLE");
  });

  it("refuses plain http before it resolves anything", async () => {
    const { real } = service();
    expect(await errorCode(() => real.probe("http://canvas.instructure.com", "tok"))).toBe("CANVAS_URL_INSECURE");
  });

  it("refuses something that is not an address", async () => {
    const { real } = service();
    expect(await errorCode(() => real.probe("not a url at all", "tok"))).toBe("CANVAS_URL_INVALID");
  });
});

describe("Canvas reads a real server", () => {
  it("verifies the token by actually using it before anything is stored", async () => {
    // /users/self is the cheapest call that proves a token is real and belongs to somebody. A source
    // created from an unverified token sits in the household's list looking healthy and producing nothing.
    const { canvas } = service();
    seen.length = 0;
    const self = await canvas.probe(origin, "tok");
    expect(self.userName).toBe("Sam Rivera");
    expect(seen.some((c) => c.path === "/api/v1/users/self")).toBe(true);
  });

  it("sends the token as a bearer header, never in the URL", async () => {
    const { canvas } = service();
    seen.length = 0;
    await canvas.fetchItems(origin, "secret-token");
    for (const call of seen) {
      expect(call.auth).toBe("Bearer secret-token");
      expect(call.path).not.toContain("secret-token");
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it("asks only for active courses", async () => {
    const { canvas } = service();
    seen.length = 0;
    await canvas.fetchItems(origin, "tok");
    const courses = seen.find((c) => c.path.startsWith("/api/v1/courses?"));
    expect(courses?.path).toContain("enrollment_state=active");
  });

  it("brings back assignments and announcements together", async () => {
    const { canvas } = service();
    const items = await canvas.fetchItems(origin, "tok");
    expect(items.map((i) => i.uid).sort()).toEqual(["announcement:55", "assignment:991", "assignment:992"]);
  });

  it("keeps the rest when one course cannot be read", async () => {
    // Course 13 returns 403. Losing course 12's deadlines because of it would be the connector failing
    // silently in the way that matters most.
    const { canvas } = service();
    const items = await canvas.fetchItems(origin, "tok");
    expect(items.some((i) => i.uid === "assignment:991")).toBe(true);
  });

  it("never asks Canvas for grades", async () => {
    // The token can read them. This app has no business storing a child's grades to answer a question
    // nobody asked it.
    const { canvas } = service();
    seen.length = 0;
    await canvas.fetchItems(origin, "tok");
    expect(seen.some((c) => /grade|submission|score/i.test(c.path))).toBe(false);
  });

  it("reads a rejected token as a rejected token, not as an outage", async () => {
    // The distinction matters to the user: an outage fixes itself, a revoked token does not, and telling
    // somebody the wrong one means they either wait forever or re-authorise for no reason.
    selfStatus = 401;
    try {
      const { canvas } = service();
      expect(await errorCode(() => canvas.probe(origin, "wrong"))).toBe("CANVAS_TOKEN_REJECTED");
    } finally {
      selfStatus = 200;
    }
  });

  it("treats a 403 on the token check the same way", async () => {
    selfStatus = 403;
    try {
      const { canvas } = service();
      expect(await errorCode(() => canvas.probe(origin, "wrong"))).toBe("CANVAS_TOKEN_REJECTED");
    } finally {
      selfStatus = 200;
    }
  });

  it("reports an unreachable host as unreachable, not as a bad token", async () => {
    const { canvas } = service();
    // A port nothing is listening on, through the same allowed host.
    expect(await errorCode(() => canvas.probe("https://127.0.0.1:1", "tok"))).toBe("CANVAS_UNREACHABLE");
  });
});
