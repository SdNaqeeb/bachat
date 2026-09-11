"""Shared collector plumbing: value types, HTTP client, rate limiting."""

from collectors.core.http import DEFAULT_HOST_DELAYS, USER_AGENT, HttpClient, HttpError, RetryPolicy
from collectors.core.ratelimit import RateLimiter
from collectors.core.types import Category, Filters, Location, Mode, Offer

__all__ = [
    "Category",
    "DEFAULT_HOST_DELAYS",
    "Filters",
    "HttpClient",
    "HttpError",
    "Location",
    "Mode",
    "Offer",
    "RateLimiter",
    "RetryPolicy",
    "USER_AGENT",
]
