"""One module per retailer, all implementing `collectors.adapters.base.Adapter`.

`ADAPTERS` is the registry the sweep entrypoint walks. Adding a deferred
retailer (Zepto, Instamart, ...) is one new module plus one line here.
"""

from __future__ import annotations

from typing import Any

from collectors.adapters.base import Adapter, BaseAdapter
from collectors.adapters.bigbasket import BigBasketAdapter
from collectors.adapters.blinkit import BlinkitAdapter

ADAPTERS: dict[str, Any] = {
    "blinkit": BlinkitAdapter,
    "bigbasket": BigBasketAdapter,
}

# Fashion adapters are owned by a parallel task; register them when present so
# neither half of the collector blocks on the other landing.
for _name, _module, _cls in (
    ("myntra", "collectors.adapters.myntra", "MyntraAdapter"),
    ("amazon", "collectors.adapters.amazon", "AmazonAdapter"),
    ("flipkart", "collectors.adapters.flipkart", "FlipkartAdapter"),
):
    try:  # pragma: no cover - import-time availability, not behaviour
        import importlib

        ADAPTERS[_name] = getattr(importlib.import_module(_module), _cls)
    except Exception:  # noqa: BLE001
        pass

__all__ = ["ADAPTERS", "Adapter", "BaseAdapter", "BigBasketAdapter", "BlinkitAdapter"]
