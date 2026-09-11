/**
 * Deals — the category sweep feed for the current mode (spec §7, §9).
 *
 * This is the secondary feature and it is built to stay secondary. Basket
 * answers a question the user already has; Deals offers information they did
 * not ask for, which means it has to be honest enough to be worth the
 * interruption. Two things do that work:
 *
 * - **Sorted by discount depth, not by recency or by retailer.** The feed's
 *   only job is "is there anything genuinely cheap today", so the deepest cut
 *   is first and there is no other ordering to learn.
 * - **Every claim carries its evidence.** A period-low badge states the real
 *   number of days behind it (spec §7), and every price carries its capture age
 *   — the fashion sweep in particular can be a day and a half old, and a feed
 *   that hid that would be recommending yesterday's prices with today's
 *   confidence.
 *
 * The feed is scoped to the categories enabled in Settings, because those are
 * the same categories that gate notifications: what you see here is what will
 * wake your phone, and the two must never disagree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Linking, RefreshControl, StyleSheet, View } from 'react-native';

import { AppHeader } from '@/components/app-header';
import { DealCard } from '@/components/deals/deal-card';
import {
  Chip,
  ChipRail,
  EmptyState,
  ErrorState,
  RowDivider,
  SectionCard,
  SkeletonList,
  StaleBanner,
} from '@/components/ui';
import { useMode } from '@/hooks/use-mode';
import { usePrefs } from '@/hooks/use-prefs';
import { apiClient } from '@/lib/client';
import { freshnessOf } from '@/lib/format';
import type { Category, Deal, DealsFeed, Mode, Retailer } from '@/lib/types';
import { palette, spacing } from '@/theme';

/** Rows requested per page, via the feed's real cursor. */
const PAGE_SIZE = 15;

export default function DealsScreen() {
  const { mode, label, accent } = useMode();
  const { prefs } = usePrefs();

  // Per mode, so flipping the header switch neither carries a grocery feed
  // into Fashion nor throws away where you were. Each feed already holds its
  // own accumulated `deals` and the `nextCursor` for its next page.
  const [feeds, setFeeds] = useState<Record<Mode, DealsFeed | null>>({
    quick: null,
    fashion: null,
  });
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selection, setSelection] = useState<Record<Mode, string | null>>({
    quick: null,
    fashion: null,
  });
  // The cursor to fetch next, per mode. `undefined` means "first page".
  const [cursors, setCursors] = useState<Record<Mode, string | undefined>>({
    quick: undefined,
    fashion: undefined,
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [scrolled, setScrolled] = useState(false);

  const requestMode = useRef<Mode>(mode);
  // Bumped on every load() call for a given mode so a response that is still
  // in flight when a newer request for the same mode starts can never land.
  const requestId = useRef<Record<Mode, number>>({ quick: 0, fashion: 0 });
  const selected = selection[mode];
  const feed = feeds[mode];
  const cursor = cursors[mode];
  const exhausted = feed !== null && feed.nextCursor == null;

  const select = useCallback(
    (categoryId: string | null) => {
      setSelection((previous) => ({ ...previous, [mode]: categoryId }));
      setCursors((previous) => ({ ...previous, [mode]: undefined }));
    },
    [mode]
  );

  /** Categories enabled in Settings, intersected with this mode's own list. */
  const enabled = useMemo(
    () => categories.filter((category) => prefs.enabledCategories.includes(category.id)),
    [categories, prefs.enabledCategories]
  );

  const queryCategories = useMemo(() => {
    if (selected !== null) return [selected];
    return enabled.map((category) => category.id);
  }, [selected, enabled]);

  const load = useCallback(
    async (target: Mode, pageCursor: string | undefined, signal?: AbortSignal) => {
      const id = ++requestId.current[target];
      const [facets, next] = await Promise.all([
        apiClient.facets(target, signal),
        apiClient.deals(
          { mode: target, categories: queryCategories, limit: PAGE_SIZE, cursor: pageCursor },
          signal
        ),
      ]);
      // A newer request for this mode (mode switch, category change, refresh,
      // or another page) started while this one was in flight — drop it.
      if (requestMode.current !== target || requestId.current[target] !== id) return;
      setRetailers(facets.retailers);
      setCategories(facets.categories);
      setFeeds((previous) => {
        // No cursor means "first page": start the accumulated list over
        // rather than appending onto whatever this mode had before.
        const priorDeals = pageCursor === undefined ? [] : previous[target]?.deals ?? [];
        return { ...previous, [target]: { ...next, deals: [...priorDeals, ...next.deals] } };
      });
      setError(null);
    },
    [queryCategories]
  );

  useEffect(() => {
    const controller = new AbortController();
    requestMode.current = mode;
    void (async () => {
      setLoading(true);
      try {
        await load(mode, cursor, controller.signal);
      } catch (caught: unknown) {
        if (!controller.signal.aborted) setError(caught);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [mode, cursor, load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setCursors((previous) => ({ ...previous, [mode]: undefined }));
    load(mode, undefined)
      .catch((caught: unknown) => setError(caught))
      .finally(() => setRefreshing(false));
  }, [mode, load]);

  // Advancing the cursor re-runs the load effect, which is the whole
  // pagination: it fetches the next page and the effect's setFeeds appends it.
  const loadMore = useCallback(() => {
    if (loading || exhausted || feed === null || feed.nextCursor == null) return;
    const nextCursor = feed.nextCursor;
    setCursors((previous) => ({ ...previous, [mode]: nextCursor }));
  }, [loading, exhausted, feed, mode]);

  const retailerById = useMemo(
    () => new Map(retailers.map((retailer) => [retailer.id, retailer])),
    [retailers]
  );

  const openDeal = useCallback((deal: Deal) => {
    void Linking.openURL(apiClient.buyUrl(deal.offer)).catch(() => {});
  }, []);

  const stale =
    feed !== null && feed.sweptAt > 0 && freshnessOf(feed.sweptAt, mode) !== 'fresh';

  const deals = feed?.deals ?? [];
  const subtitle = loading
    ? label
    : `${deals.length} ${deals.length === 1 ? 'deal' : 'deals'} in ${label}`;

  const header = (
    <View>
      {stale && feed ? (
        <StaleBanner
          sweptAt={feed.sweptAt}
          detail="These are the last prices Bachat collected, not live ones."
          onRetry={refresh}
          style={styles.banner}
        />
      ) : null}

      {enabled.length > 1 ? (
        <ChipRail layout="scroll" style={styles.rail}>
          <Chip
            label="Everything"
            selected={selected === null}
            accent={accent.accent}
            accentWash={accent.wash}
            onPress={() => select(null)}
          />
          {enabled.map((category) => (
            <Chip
              key={category.id}
              label={category.label}
              selected={selected === category.id}
              accent={accent.accent}
              accentWash={accent.wash}
              onPress={() => select(category.id)}
            />
          ))}
        </ChipRail>
      ) : null}
    </View>
  );

  if (error !== null && feed === null) {
    return (
      <View style={styles.screen}>
        <AppHeader title="Deals" subtitle={label} />
        <ErrorState error={error} onRetry={refresh} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AppHeader title="Deals" subtitle={subtitle} scrolled={scrolled} />

      {loading && feed === null ? (
        <SectionCard flush style={styles.loadingCard}>
          <SkeletonList count={6} />
        </SectionCard>
      ) : (
        <FlatList
          data={deals}
          keyExtractor={(deal) => `${deal.offer.productId}-${deal.kind}`}
          ListHeaderComponent={header}
          onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 4)}
          scrollEventThrottle={32}
          onEndReached={loadMore}
          onEndReachedThreshold={0.6}
          contentContainerStyle={styles.content}
          ItemSeparatorComponent={RowDivider}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={accent.accent}
              colors={[accent.accent]}
            />
          }
          ListEmptyComponent={
            <EmptyState
              headline={
                enabled.length === 0
                  ? 'No categories followed yet'
                  : 'Nothing worth interrupting you for'
              }
              caption={
                enabled.length === 0
                  ? `Pick the ${label.toLowerCase()} categories you care about in Settings, and this feed — and your alerts — will follow them.`
                  : `Nothing in the last sweep beat your ${Math.round(
                      prefs.threshold * 100
                    )}% threshold or hit a recorded low. Lower the threshold in Settings to see more.`
              }
              icon="pricetags-outline"
              style={styles.empty}
            />
          }
          renderItem={({ item }) => {
            const retailer = retailerById.get(item.offer.retailerId);
            if (!retailer) return null;
            return (
              <DealCard deal={item} retailer={retailer} onBuy={() => openDeal(item)} />
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.void,
  },
  content: {
    paddingBottom: spacing.huge,
  },
  banner: {
    marginBottom: spacing.sm,
  },
  rail: {
    paddingVertical: spacing.md,
    backgroundColor: palette.void,
  },
  loadingCard: {
    marginTop: spacing.md,
  },
  empty: {
    paddingVertical: spacing.huge * 2,
    backgroundColor: palette.void,
  },
});
