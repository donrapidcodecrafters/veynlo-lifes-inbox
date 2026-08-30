import "@testing-library/jest-dom/vitest";
import { expect } from "vitest";
import { toHaveNoViolations } from "jest-axe";

// jest-axe's matcher is test-framework-agnostic (just `expect.extend`), so it works under vitest exactly
// as it would under Jest — nothing here is a Jest-specific shim.
expect.extend(toHaveNoViolations);
