"""The allow_unpriced toggle (GitHub #50): unpriced parts join the pool without ever counting as free."""

from models_item_offers import ItemOffer
from optimizer.explore import explore_weapon
from optimizer.solver import OptimizeParams, _load_candidates_and_prices, optimize_weapon
from tests.test_reachability_integration import db, setup_graph  # noqa: F401


def _unpriced_graph(db):  # noqa: F811
    # Give the unpriced part the best ergo, like the Arena-only stock in #50.
    setup_graph(db, {("stock", "gun"): ["a_stock", "b_stock", "arena"]}, fields={"arena": {"ergonomics_modifier": 50}})
    db.query(ItemOffer).filter_by(item_id="arena").delete()
    db.commit()


def test_unpriced_parts_stay_out_by_default(db):  # noqa: F811
    _unpriced_graph(db)
    result = optimize_weapon(db, "gun", OptimizeParams(recoil_weight=0.0))
    assert result["status"] == "optimal"
    assert "arena" not in result["selected_items"]
    assert result["unpriced_items"] == []


def test_allow_unpriced_admits_them_without_pricing_them(db):  # noqa: F811
    _unpriced_graph(db)
    result = optimize_weapon(db, "gun", OptimizeParams(recoil_weight=0.0, allow_unpriced=True))
    assert result["status"] == "optimal"
    assert result["selected_items"] == ["arena"]
    assert result["unpriced_items"] == ["arena"]
    assert result["item_prices"]["arena"]["no_price"] is True
    assert result["item_prices"]["arena"]["price_rub"] == 0
    # Only the gun's own price is known. The placeholder solver cost never leaks out.
    assert result["total_price_rub"] == 0
    assert result["grand_total_rub"] == 100


def test_unpriced_parts_cost_more_than_every_priced_part_inside_the_solver(db):  # noqa: F811
    _unpriced_graph(db)
    _, _, _, (candidate_ids, prices) = _load_candidates_and_prices(db, "gun", OptimizeParams(allow_unpriced=True))
    assert "arena" in candidate_ids
    priced = [p["price_rub"] for iid, p in prices.items() if iid != "arena"]
    assert prices["arena"]["price_rub"] > max(priced)


def test_a_budget_drops_unpriced_parts_again(db):  # noqa: F811
    _unpriced_graph(db)
    params = OptimizeParams(recoil_weight=0.0, allow_unpriced=True, max_price=1_000_000)
    result = optimize_weapon(db, "gun", params)
    assert result["status"] == "optimal"
    assert "arena" not in result["selected_items"]


def test_explore_keeps_unpriced_parts_off_curves_that_plot_price(db):  # noqa: F811
    _unpriced_graph(db)
    params = OptimizeParams(allow_unpriced=True)
    ergo_recoil = explore_weapon(db, "gun", params, tradeoff="price", steps=10)
    assert any("arena" in p["build"]["selected_items"] for p in ergo_recoil["points"])
    for tradeoff in ("recoil", "ergo"):
        data = explore_weapon(db, "gun", params, tradeoff=tradeoff, steps=10)
        assert data["points"]
        assert not any("arena" in p["build"]["selected_items"] for p in data["points"])
