"""Warehouse scene browser tests (Task 5, owned by B).

Run from the project root:

    $env:PLAYWRIGHT_BROWSERS_PATH="$PWD\.playwright-browsers"
    .\.venv\Scripts\python.exe tests\warehouse_browser.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import expect  # noqa: E402

from browser_harness import PROJECT_ROOT, BrowserHarness  # noqa: E402

FIXTURE_PATH = "tests/fixtures/warehouse.html"

DIAL_TARGETS = {"amplitude": 2, "frequency": 3, "phase": 1}
CABLE_ROUTE = [("energy", "stabilizer"), ("stabilizer", "focus"), ("focus", "frame")]


def main():
    failures = 0
    scenarios = [
        ("无遗物完整路线", False, [
            test_audio_check_marker,
            test_start_disabled_before_assembly,
            test_full_route_without_relic,
            test_wrong_connections_keep_progress,
            test_partial_reset_only_clears_target_system,
            test_update_context_keeps_progress,
            test_click_only_interaction_flow,
        ]),
        ("有遗物捷径路线", True, [
            test_audio_check_marker,
            test_full_route_with_relic_skips_dials,
        ]),
    ]

    with BrowserHarness(game_dir=PROJECT_ROOT) as harness:
        errors = []
        failed_responses = []
        harness.page.on(
            "console",
            lambda message: errors.append(message.text) if message.type == "error" else None,
        )
        harness.page.on(
            "pageerror",
            lambda error: errors.append(str(error)),
        )
        harness.page.on(
            "response",
            lambda response: failed_responses.append(f"{response.status} {response.url}")
            if response.status >= 400
            else None,
        )

        for label, relic, tests in scenarios:
            print(f"\n=== {label} (relic={relic}) ===")
            for test in tests:
                # 每个测试前重新加载夹具，保证场景状态互不污染
                errors.clear()
                failed_responses.clear()
                harness.open(f"{FIXTURE_PATH}?relic={1 if relic else 0}")
                expect(harness.page.locator("[data-scene='warehouse']")).to_be_visible()
                name = test.__name__
                try:
                    test(harness.page)
                    print(f"PASS {name}")
                except Exception as error:  # noqa: BLE001
                    failures += 1
                    print(f"FAIL {name}: {error}")
                if errors:
                    failures += 1
                    print(f"FAIL console errors: {errors}")
                if failed_responses:
                    failures += 1
                    print(f"FAIL http >=400: {failed_responses}")

    if failures:
        print(f"\n{failures} failure(s)")
        return 1
    print("\nAll warehouse browser tests passed.")
    return 0


def click_part(page, part_id):
    page.click(f"[data-testid='part-{part_id}']")


def click_slot(page, slot_id):
    page.click(f"[data-testid='slot-{slot_id}']")


def connect_cable(page, from_id, to_id):
    page.click(f"[data-testid='node-{from_id}']")
    page.click(f"[data-testid='node-{to_id}']")


def raise_dial(page, dial_id, times):
    for _ in range(times):
        page.click(f"[data-testid='dial-{dial_id}-up']")


def assemble_and_wire(page):
    for part_id in ("energy", "stabilizer", "focus"):
        click_part(page, part_id)
        click_slot(page, part_id)
    for from_id, to_id in CABLE_ROUTE:
        connect_cable(page, from_id, to_id)


def test_audio_check_marker(page):
    assert page.locator("[data-testid='audio-check']").text_content() == "safe"


def test_start_disabled_before_assembly(page):
    start = page.locator("[data-testid='start-portal']")
    expect(start).to_be_disabled()


def test_full_route_without_relic(page):
    assemble_and_wire(page)

    for dial_id, target in DIAL_TARGETS.items():
        dial = page.locator(f"[data-testid='dial-{dial_id}']")
        raise_dial(page, dial_id, target)
        expect(dial).to_have_attribute("data-locked", "true")

    start = page.locator("[data-testid='start-portal']")
    expect(start).to_be_enabled()
    start.click()

    expect(page.locator("[data-testid='portal']")).to_have_attribute(
        "data-state", "open"
    )
    expect(page.locator("[data-testid='complete-count']")).to_have_text("1")

    start.click()
    expect(page.locator("[data-testid='complete-count']")).to_have_text("1")

    sound_log = page.locator("[data-testid='sound-log']").text_content()
    for sound_id in (
        "warehouse.place",
        "warehouse.cable",
        "warehouse.dial",
        "warehouse.portal",
    ):
        assert sound_id in sound_log
    expect(page.locator("[data-testid='interaction-count']")).not_to_have_text("0")


def test_full_route_with_relic_skips_dials(page):
    assert page.locator("[data-testid='dial-panel']").is_hidden()
    assert page.locator("[data-testid='relic-slot']").count() == 0

    assemble_and_wire(page)

    start = page.locator("[data-testid='start-portal']")
    expect(start).to_be_enabled()
    start.click()

    expect(page.locator("[data-testid='portal']")).to_have_attribute(
        "data-state", "open"
    )
    expect(page.locator("[data-testid='complete-count']")).to_have_text("1")


def test_wrong_connections_keep_progress(page):
    click_part(page, "energy")
    click_slot(page, "energy")

    connect_cable(page, "frame", "energy")
    feedback = page.locator("[data-testid='warehouse-feedback']")
    expect(feedback).to_contain_text("方向")
    assert page.locator("[data-cable-id]").count() == 0

    connect_cable(page, "energy", "stabilizer")
    assert page.locator("[data-cable-id='energy->stabilizer']").count() == 1

    connect_cable(page, "energy", "stabilizer")
    expect(feedback).to_contain_text("已经")
    assert page.locator("[data-cable-id]").count() == 1

    for from_id, to_id in CABLE_ROUTE[1:]:
        connect_cable(page, from_id, to_id)
    assert page.locator("[data-cable-id]").count() == 3
    expect(page.locator("[data-testid='start-portal']")).to_be_disabled()


def test_partial_reset_only_clears_target_system(page):
    click_part(page, "energy")
    click_slot(page, "energy")
    connect_cable(page, "energy", "stabilizer")
    raise_dial(page, "amplitude", 1)

    page.click("[data-testid='reset-wiring']")
    assert page.locator("[data-cable-id]").count() == 0
    expect(page.locator("[data-testid='slot-energy']")).to_have_attribute(
        "data-filled", "true"
    )
    amplitude = page.locator("[data-testid='dial-amplitude']")
    expect(amplitude).to_have_attribute("data-value", "1")

    raise_dial(page, "amplitude", 1)
    page.click("[data-testid='reset-dials']")
    expect(amplitude).to_have_attribute("data-value", "0")
    expect(amplitude).to_have_attribute("data-locked", "false")
    expect(page.locator("[data-testid='slot-energy']")).to_have_attribute(
        "data-filled", "true"
    )
    expect(page.locator("[data-testid='start-portal']")).to_be_disabled()


def test_update_context_keeps_progress(page):
    click_part(page, "energy")
    click_slot(page, "energy")
    connect_cable(page, "energy", "stabilizer")

    container_children = page.evaluate(
        "document.querySelectorAll('#scene-container > *').length"
    )
    assert container_children == 1

    page.evaluate(
        "window.__warehouseHandle.updateContext({ hasSanityRelic: true })"
    )
    expect(page.locator("[data-testid='dial-panel']")).to_be_hidden()
    expect(page.locator("[data-testid='slot-energy']")).to_have_attribute(
        "data-filled", "true"
    )
    assert page.locator("[data-cable-id='energy->stabilizer']").count() == 1
    assert page.evaluate(
        "document.querySelectorAll('#scene-container > *').length"
    ) == container_children

    page.evaluate(
        "window.__warehouseHandle.updateContext({ hasSanityRelic: false })"
    )
    expect(page.locator("[data-testid='dial-panel']")).to_be_visible()
    expect(page.locator("[data-testid='slot-energy']")).to_have_attribute(
        "data-filled", "true"
    )
    assert page.locator("[data-cable-id='energy->stabilizer']").count() == 1


def test_click_only_interaction_flow(page):
    parts = page.locator("[data-testid^='part-']")
    slots = page.locator("[data-testid^='slot-']")
    assert parts.count() == 3
    assert slots.count() == 3
    for index in range(parts.count()):
        expect(parts.nth(index)).to_have_attribute("data-action", "select-part")
    for index in range(slots.count()):
        expect(slots.nth(index)).to_have_attribute("data-action", "install-part")


if __name__ == "__main__":
    sys.exit(main())
