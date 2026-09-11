/**
 * Basket — the screen the product exists for (spec §8).
 *
 * The user's chore is opening Blinkit, Zepto, Instamart, BigBasket and Amazon
 * in sequence and adding prices up by hand. This screen is that chore, done.
 * Everything about its layout follows from one constraint: the answer has to be
 * legible in about a second, at arm's length, in daylight.
 *
 * So the page is ordered verdict, contenders, list — never list first. The
 * verdict card owns the only hero-sized number in the app; the contenders are a
 * flat hairline table underneath it; the regulars sit at the bottom because
 * they are what you *change*, not what you *read*.
 *
 * Ranking is by basket total including fees, and only a fully-stocked retailer
 * can win outright. When none is, the screen says so plainly rather than
 * promoting a partial basket into the winner's slot — a wrong confident answer
 * is worse here than no answer.
 *
 * Edits are optimistic. The list re-renders immediately, `saveBasket` goes out
 * behind it, and the comparison refetches once the write lands; a stepper that
 * waits for Cloudflare before showing "3" would make the most-touched control
 * in the app feel broken.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppHeader } from '@/components/app-header';
import { BasketEditor } from '@/components/basket/basket-editor';
import { BasketEmpty } from '@/components/basket/basket-empty';
import { ContenderRow } from '@/components/basket/contender-row';
import { VerdictCard } from '@/components/basket/verdict-card';
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import {
  ErrorState,
  RowDivider,
  SectionCard,
  SectionHeading,
  SkeletonList,
  StalenessChip,
  StaleBanner,
} from '@/components/ui';
import { useMode } from '@/hooks/use-mode';
import { usePrefs } from '@/hooks/use-prefs';
import { apiClient } from '@/lib/client';
import { freshnessOf } from '@/lib/format';
import type {
  BasketComparison,
  BasketItem,
  Category,
  Mode,
  Retailer,
} from '@/lib/types';
import { layout, palette, radius, spacing, type } from '@/theme';

/** How long an edit sits before it is written and the comparison refetched. */
const SAVE_DEBOUNCE_MS = 600;

export default function BasketScreen() {
  const { mode, label, accent } = useMode();
  const { prefs, settings } = usePrefs();

  const [comparison, setComparison] = useState<BasketComparison | null>(null);
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<BasketItem[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);

  /**
   * First run. There is no "onboarded" flag in the stored settings, so this is
   * inferred from the three things setup actually writes: an untouched install
   * has no pincode, follows no categories and has never seen the battery step.
   * Inferring it beats adding a flag to a shape the collector also reads.
   */
  const needsSetup =
    !setupDismissed &&
    !settings.batteryGuideDone &&
    prefs.pincode.length === 0 &&
    prefs.enabledCategories.length === 0;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slow response for the previous mode overwriting the new one.
  const requestMode = useRef<Mode>(mode);

  const load = useCallback(
    async (target: Mode, signal?: AbortSignal) => {
      const [next, facets] = await Promise.all([
        apiClient.basket(target, signal),
        apiClient.facets(target, signal),
      ]);
      if (requestMode.current !== target) return;
      setComparison(next);
      setRetailers(facets.retailers);
      setCategories(facets.categories);
      setItems(next.lines.map((line) => line.item));
      setError(null);
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    requestMode.current = mode;
    void (async () => {
      setLoading(true);
      setComparison(null);
      try {
        await load(mode, controller.signal);
      } catch (caught: unknown) {
        if (requestMode.current === mode) setError(caught);
      } finally {
        if (requestMode.current === mode) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [mode, load]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    load(mode)
      .catch((caught: unknown) => setError(caught))
      .finally(() => setRefreshing(false));
  }, [mode, load]);

  /** Optimistic: paint the edit now, persist and re-price behind it. */
  const commitItems = useCallback(
    (next: BasketItem[]) => {
      setItems(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        apiClient
          .saveBasket(
            mode,
            next.map((item) => ({
              id: item.id.startsWith('local-') ? undefined : item.id,
              label: item.label,
              qty: item.qty,
              mode,
              category: item.category,
            }))
          )
          .then(() => load(mode))
          .catch((caught: unknown) => setError(caught));
      }, SAVE_DEBOUNCE_MS);
    },
    [mode, load]
  );

  const addStarter = useCallback(
    (starter: string) => {
      if (items.some((item) => item.label === starter)) return;
      commitItems([
        ...items,
        {
          id: `local-${Date.now()}`,
          label: starter,
          qty: 1,
          mode,
          category: categories[0]?.id ?? '',
        },
      ]);
    },
    [items, mode, categories, commitItems]
  );

  const retailerById = useMemo(
    () => new Map(retailers.map((retailer) => [retailer.id, retailer])),
    [retailers]
  );

  const openRetailer = useCallback(
    (retailerId: string) => {
      const line = comparison?.lines.find((candidate) =>
        candidate.offers.some((offer) => offer.retailerId === retailerId && offer.inStock)
      );
      const offer = line?.offers.find(
        (candidate) => candidate.retailerId === retailerId && candidate.inStock
      );
      if (!offer) return;
      // Bachat never handles a cart: it hands the user to the retailer (spec §9).
      void Linking.openURL(apiClient.buyUrl(offer)).catch(() => {});
    },
    [comparison]
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setScrolled(event.nativeEvent.contentOffset.y > 4);
  }, []);

  const winner = comparison?.quotes.find(
    (quote) => quote.retailerId === comparison.winnerRetailerId
  );
  const winnerRetailer = winner ? retailerById.get(winner.retailerId) : undefined;
  const runnerUpName = comparison?.runnerUpRetailerId
    ? (retailerById.get(comparison.runnerUpRetailerId)?.name ?? null)
    : null;
  const contenders = (comparison?.quotes ?? []).filter(
    (quote) => quote.retailerId !== winner?.retailerId
  );

  const stale =
    comparison !== null &&
    comparison.capturedAt > 0 &&
    freshnessOf(comparison.capturedAt, mode) === 'stale';

  const subtitle = loading
    ? label
    : items.length === 0
      ? label
      : `${items.length} ${items.length === 1 ? 'regular' : 'regulars'} in ${label}`;

  return (
    <View style={styles.screen}>
      <AppHeader title="Basket" subtitle={subtitle} scrolled={scrolled} />

      {error !== null && comparison === null ? (
        <ErrorState error={error} onRetry={refresh} />
      ) : (
        <ScrollView
          onScroll={onScroll}
          scrollEventThrottle={32}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={accent.accent}
              colors={[accent.accent]}
            />
          }
        >
          {stale && comparison ? (
            <StaleBanner
              sweptAt={comparison.capturedAt}
              detail="A sweep has been missed, so these totals may not be what you would pay right now."
              onRetry={refresh}
              style={styles.banner}
            />
          ) : null}

          {loading ? (
            <SectionCard flush style={styles.loadingCard}>
              <SkeletonList count={4} />
            </SectionCard>
          ) : items.length === 0 ? (
            <BasketEmpty
              mode={mode}
              accent={accent.accent}
              accentWash={accent.wash}
              chosen={items.map((item) => item.label)}
              onAdd={addStarter}
            />
          ) : (
            <>
              {winner && winnerRetailer ? (
                <VerdictCard
                  quote={winner}
                  retailer={winnerRetailer}
                  mode={mode}
                  saving={comparison?.savingVsRunnerUp ?? null}
                  runnerUpName={runnerUpName}
                  onBuy={() => openRetailer(winner.retailerId)}
                />
              ) : (
                <NoWinnerNotice itemCount={items.length} />
              )}

              {contenders.length > 0 ? (
                <>
                  <SectionHeading
                    title={winner ? 'The other apps' : 'What each app has'}
                    caption="Totals include that app's delivery and handling fees."
                  />
                  <SectionCard flush>
                    {contenders.map((quote, index) => {
                      const retailer = retailerById.get(quote.retailerId);
                      if (!retailer) return null;
                      return (
                        <View key={quote.retailerId}>
                          {index > 0 ? <RowDivider /> : null}
                          <ContenderRow
                            quote={quote}
                            retailer={retailer}
                            lines={comparison?.lines ?? []}
                            mode={mode}
                            winnerTotal={winner?.total ?? null}
                            onBuy={() => openRetailer(quote.retailerId)}
                          />
                        </View>
                      );
                    })}
                  </SectionCard>
                </>
              ) : null}

              <SectionHeading
                title="Your regulars"
                trailing={
                  comparison && comparison.capturedAt > 0 ? (
                    <StalenessChip
                      capturedAt={comparison.capturedAt}
                      mode={mode}
                      prefix="priced"
                    />
                  ) : null
                }
              />
              <SectionCard flush>
                <BasketEditor
                  items={items}
                  categories={categories}
                  mode={mode}
                  accent={accent.accent}
                  accentWash={accent.wash}
                  onChange={commitItems}
                />
              </SectionCard>
            </>
          )}
        </ScrollView>
      )}

      <Modal
        visible={needsSetup}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setSetupDismissed(true)}
      >
        <OnboardingFlow onDone={() => setSetupDismissed(true)} />
      </Modal>
    </View>
  );
}

/** Shown when nothing is fully stocked — the one case with no honest winner. */
function NoWinnerNotice({ itemCount }: { itemCount: number }) {
  return (
    <View style={styles.notice}>
      <Ionicons name="alert-circle-outline" size={22} color={palette.stale} />
      <View style={styles.noticeBody}>
        <Text maxFontSizeMultiplier={1.3} style={styles.noticeTitle}>
          No app has all {itemCount} items right now
        </Text>
        <Text maxFontSizeMultiplier={1.3} style={styles.noticeText}>
          Every option below is missing something, so none of them is a clean win. Each
          one states its gap — pick the one whose gap you can live without.
        </Text>
      </View>
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
    marginBottom: spacing.md,
  },
  loadingCard: {
    marginTop: spacing.sm,
  },
  notice: {
    flexDirection: 'row',
    gap: spacing.md,
    marginHorizontal: layout.screenPadding,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: palette.staleWash,
  },
  noticeBody: {
    flex: 1,
    gap: spacing.xs,
  },
  noticeTitle: {
    ...type.subtitle,
    color: palette.textPrimary,
  },
  noticeText: {
    ...type.caption,
    color: palette.textSecondary,
  },
});
