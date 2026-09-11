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

/**
 * Rows per page. The Worker contract takes a `limit` rather than a cursor, so
 * "next page" is a larger limit — fine at this catalog size, and the one place
 * to change if the contract grows a real cursor.
 */
const PAGE_SIZE = 15;

export default function DealsScreen() {
  const { mode, label, accent } = useMode();
  const { prefs } = usePrefs();

  const [feed, setFeed] = useState<DealsFeed | null>(null);
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  // Per mode, so flipping the header switch neither carries a grocery category
  // into Fashion nor throws away where you were.
  const [selection, setSelection] = useState<Record<Mode, string | null>>({
    quick: null,
    fashion: null,
  });
  const [limits, setLimits] = useState<Record<Mode, number>>({
    quick: PAGE_SIZE,
    fashion: PAGE_SIZE,
  });
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [scrolled, setScrolled] = useState(false);

  const requestMode = useRef<Mode>(mode);
  const selected = selection[mode];
  const limit = limits[mode];

  const select = useCallback(
    (categoryId: string | null) => {
      setSelection((previous) => ({ ...previous, [mode]: categoryId }));
      setLimits((previous) => ({ ...previous, [mode]: PAGE_SIZE }));
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
    async (target: Mode, nextLimit: number, signal?: AbortSignal) => {
      const [facets, next] = await Promise.all([
        apiClient.facets(target, signal),
        apiClient.deals({ mode: target, categories: queryCategories, limit: nextLimit }, signal),
      ]);
      if (requestMode.current !== target) return;
      setRetailers(facets.retailers);
      setCategories(facets.categories);
      setFeed(next);
      setExhausted(next.deals.length < nextLimit);
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
        await load(mode, limit, controller.signal);
      } catch (caught: unknown) {
        if (!controller.signal.aborted) setError(caught);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [mode, limit, load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setLimits((previous) => ({ ...previous, [mode]: PAGE_SIZE }));
    load(mode, PAGE_SIZE)
      .catch((caught: unknown) => setError(caught))
      .finally(() => setRefreshing(false));
  }, [mode, load]);

  // Raising the limit re-runs the load effect, which is the whole pagination.
  const loadMore = useCallback(() => {
    if (loading || exhausted || feed === null) return;
    setLimits((previous) => ({ ...previous, [mode]: previous[mode] + PAGE_SIZE }));
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
