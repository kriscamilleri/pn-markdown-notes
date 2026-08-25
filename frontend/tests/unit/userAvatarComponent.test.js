// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import UserAvatar from "../../src/components/UserAvatar.vue";
import AvatarStack from "../../src/components/AvatarStack.vue";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

describe("UserAvatar rendering", () => {
  it("renders initials and carries the full name in aria-label", () => {
    const wrapper = mount(UserAvatar, {
      props: { user: { id: ALICE, name: "Jane Doe", email: "" } },
    });
    const swatch = wrapper.get('[data-testid="user-avatar"]');
    expect(swatch.text()).toBe("JD");
    expect(swatch.attributes("aria-label")).toBe("Jane Doe");
    expect(swatch.attributes("data-user-id")).toBe(ALICE);
  });

  it("renders an accessible fallback label for an empty user", () => {
    const wrapper = mount(UserAvatar, {
      props: { user: { id: "", name: "", email: "" } },
    });
    const swatch = wrapper.get('[data-testid="user-avatar"]');
    expect(swatch.text()).toBe("?");
    expect(swatch.attributes("aria-label")).toBe("Unknown collaborator");
  });
});

describe("AvatarStack rendering", () => {
  it("renders a +N pill past the cap", () => {
    const users = [
      { id: ALICE, name: "Jane Doe" },
      { id: BOB, name: "John Smith" },
    ];
    const wrapper = mount(AvatarStack, {
      props: { users, max: 1 },
    });
    expect(wrapper.get('[data-testid="avatar-stack-overflow"]').text()).toBe("+1");
    expect(wrapper.findAll('[data-testid="user-avatar"]').length).toBe(1);
  });
});
