// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

const harness = vi.hoisted(() => ({
  acceptInvitation: vi.fn(async () => ({ accepted: true })),
  replace: vi.fn(async () => {}),
  push: vi.fn(),
  token: "raw-invite-token",
}));

vi.mock("@/store/spacesStore", () => ({
  useSpacesStore: () => ({ acceptInvitation: harness.acceptInvitation }),
}));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { token: harness.token } }),
  useRouter: () => ({ replace: harness.replace, push: harness.push }),
}));

const AcceptSpaceInvitePage = (await import("@/pages/AcceptSpaceInvitePage.vue")).default;
const global = {
  stubs: {
    AccountLayout: { template: "<main><slot /></main>" },
    BaseButton: { template: "<button v-bind='$attrs'><slot /></button>" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.token = "raw-invite-token";
});

describe("AcceptSpaceInvitePage", () => {
  it("never accepts merely by visiting and clears the token after explicit acceptance", async () => {
    const wrapper = mount(AcceptSpaceInvitePage, { global });
    expect(harness.acceptInvitation).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("does not accept it automatically");
    await wrapper.get("[data-testid='invite-accept']").trigger("click");
    expect(harness.acceptInvitation).toHaveBeenCalledWith("raw-invite-token");
    expect(harness.replace).toHaveBeenCalledWith({ name: "space-invitation" });
    expect(wrapper.get("[data-testid='invite-accepted']").exists()).toBe(true);
  });

  it("uses neutral copy when no token is present", () => {
    harness.token = "";
    const wrapper = mount(AcceptSpaceInvitePage, { global });
    expect(wrapper.get("[data-testid='invite-error']").text()).toContain("invalid");
    expect(wrapper.text()).not.toContain("space id");
  });
});

