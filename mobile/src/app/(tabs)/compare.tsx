/**
 * Compare — one item, every retailer (spec §9).
 *
 * Basket answers "which app for my whole order". This screen answers the
 * narrower question the user still has a few times a week: I want this one
 * thing, who has it cheapest right now. It is deliberately not a catalogue
 * browser — there is no infinite feed and no recommendations, only a field and
 * the answer.
 *
 * Two behaviours are worth knowing about:
 *
 * - **Fashion filters push to the server.** Myntra exposes brand and size as
 *   server-side facets (spec §3), so changing a chip refetches rather than
 *   filtering the results already on screen. That is why the facet bar warns
 *   that each change costs a fetch, and why filters are hidden entirely in
 *   quick commerce, where "size M" is meaningless.
 * - **Search state is kept per mode.** Flipping to Fashion mid-search for milk
 *   should not run "milk" against Myntra, and flipping back should not have
 *   thrown the grocery search away. Each mode keeps its own query and its own
 *   filters, and the header switch moves between them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Linking, StyleSheet, View } from 'react-native';

import { AppHeader } from '@/components/app-header';
import { FacetFilters } from '@/components/compare/facet-filters';
import { RetailerGroup } from '@/components/compare/retailer-group';
import {
  Chip,
  ChipRail,
  EmptyState,
  ErrorState,
  SectionCard,
  SkeletonList,
  TextField,
} from '@/components/ui';
import { useMode } from '@/hooks/use-mode';
import { apiClient } from '@/lib/client';
import type { Facets, Mode, Offer, Retailer } from '@/lib/types';
import { layout, palette, spacing } from '@/theme';

/** Long enough that a two-letter typo does not cost a round trip. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 400;

/** Per-mode search state, so a mode flip neither carries over nor discards. */
type SearchState = { query: string; brands: string[]; sizes: string[] };

/**
 * One search's result, tagged with the search that produced it. Keeping the tag
 * beside the data is what lets "are we still loading?" and "is this result for
 * what is currently typed?" both be derived rather than tracked in their own
 * state — a stale result can never be shown against a newer query.
 */
type Outcome = { key: string; offers: Offer[] | null; error: unknown };

const EMPTY_SEARCH: SearchState = { query: '', brands: [], sizes: [] };

/** Starting points, so an empty screen is still a usable one. */
const SUGGESTIONS: Record<Mode, string[]> = {
  quick: ['Milk', 'Atta', 'Toor dal', 'Eggs', 'Coffee', 'Detergent'],
  fashion: ['T-shirt', 'Jeans', 'Sneakers', 'Kurta', 'Formal shirt'],
};

export default function CompareScreen() {
  const { mode, label, accent } = useMode();

  const [searches, setSearches] = useState<Record<Mode, SearchState>>({
    quick: EMPTY_SEARCH,
    fashion: EMPTY_SEARCH,
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  const search = searches[mode];

  const patch = useCallback(
    (partial: Partial<SearchState>) => {
      setSearches((previous) => ({ ...previous, [mode]: { ...previous[mode], ...partial } }));
    },
    [mode]
  );

  // Facets carry the retailer list every result row needs, so they load per
  // mode regardless of whether a search has been typed yet.
  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .facets(mode, controller.signal)
      .then(setFacets)
      .catch(() => {
        // A facet failure only costs the filter chips; the search still works.
      });
    return () => controller.abort();
  }, [mode]);

  const trimmed = search.query.trim();
  const ready = trimmed.length >= MIN_QUERY;
  /** Identity of the search currently on screen. `attempt` is what retry bumps. */
  const key = `${mode}|${trimmed}|${search.brands.join(',')}|${search.sizes.join(',')}|${attempt}`;

  const current = outcome?.key === key ? outcome : null;
  const offers = current?.offers ?? null;
  const error = current?.error ?? null;
  const loading = ready && current === null;

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();

    const timer = setTimeout(() => {
      apiClient
        .compare(
          {
            mode,
            query: trimmed,
            // Facets are fashion-only; sending them in quick mode would be noise.
            brands: mode === 'fashion' ? search.brands : undefined,
            sizes: mode === 'fashion' ? search.sizes : undefined,
          },
          controller.signal
        )
        .then((result) => setOutcome({ key, offers: result.offers, error: null }))
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          setOutcome({ key, offers: null, error: caught });
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [ready, key, mode, trimmed, search.brands, search.sizes]);

  const retailerById = useMemo(
    () => new Map((facets?.retailers ?? []).map((retailer) => [retailer.id, retailer])),
    [facets]
  );

  /** Retailers ordered by their own cheapest in-stock offer (spec §9). */
  const groups = useMemo(() => {
    if (offers === null) return [];
    const buckets = new Map<string, Offer[]>();
    for (const offer of offers) {
      const bucket = buckets.get(offer.retailerId);
      if (bucket) bucket.push(offer);
      else buckets.set(offer.retailerId, [offer]);
    }

    const best = (list: Offer[]) => {
      const stocked = list.filter((offer) => offer.inStock);
      const pool = stocked.length > 0 ? stocked : list;
      return Math.min(...pool.map((offer) => offer.price));
    };

    return [...buckets.entries()]
      .map(([retailerId, list]) => ({
        retailer: retailerById.get(retailerId),
        offers: [...list].sort((a, b) => {
          if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
          return a.price - b.price;
        }),
        best: best(list),
      }))
      .filter(
        (group): group is { retailer: Retailer; offers: Offer[]; best: number } =>
          group.retailer !== undefined
      )
      .sort((a, b) => a.best - b.best);
  }, [offers, retailerById]);

  const openOffer = useCallback((offer: Offer) => {
    void Linking.openURL(apiClient.buyUrl(offer)).catch(() => {});
  }, []);

  const resultCount = offers?.length ?? 0;
  const subtitle =
    offers === null
      ? label
      : `${resultCount} ${resultCount === 1 ? 'match' : 'matches'} for “${trimmed}”`;

  const header = (
    <View style={styles.controls}>
      <TextField
        value={search.query}
        onChangeText={(query) => patch({ query })}
        accent={accent.accent}
        icon="search"
        clearable
        autoCorrect={false}
        returnKeyType="search"
        placeholder={mode === 'quick' ? 'Search groceries' : 'Search clothes and shoes'}
        accessibilityLabel="Search every retailer"
        style={styles.field}
      />

      {mode === 'fashion' && facets ? (
        <FacetFilters
          brands={facets.brands}
          sizes={facets.sizes}
          selectedBrands={search.brands}
          selectedSizes={search.sizes}
          accent={accent.accent}
          accentWash={accent.wash}
          onToggleBrand={(brand) =>
            patch({
              brands: search.brands.includes(brand)
                ? search.brands.filter((entry) => entry !== brand)
                : [...search.brands, brand],
            })
          }
          onToggleSize={(size) =>
            patch({
              sizes: search.sizes.includes(size)
                ? search.sizes.filter((entry) => entry !== size)
                : [...search.sizes, size],
            })
          }
          onClear={() => patch({ brands: [], sizes: [] })}
        />
      ) : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      <AppHeader title="Compare" subtitle={subtitle} scrolled={scrolled} />

      <FlatList
        data={groups}
        keyExtractor={(group) => group.retailer.id}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 4)}
        scrollEventThrottle={32}
        contentContainerStyle={styles.content}
        ListEmptyComponent={
          loading ? (
            <SectionCard flush style={styles.loadingCard}>
              <SkeletonList count={4} />
            </SectionCard>
          ) : error !== null ? (
            <ErrorState
              error={error}
              onRetry={() => setAttempt((previous) => previous + 1)}
              style={styles.filler}
            />
          ) : trimmed.length < MIN_QUERY ? (
            <EmptyState
              headline="Price one thing everywhere"
              caption={
                mode === 'quick'
                  ? 'Type what you want and Bachat checks every quick-commerce app at once, with the age of each price.'
                  : 'Type what you want and Bachat checks Myntra, Amazon and Flipkart at once. Brand and size filters run at the retailer.'
              }
              icon="search-outline"
              style={styles.filler}
            >
              <ChipRail style={styles.suggestions}>
                {SUGGESTIONS[mode].map((suggestion) => (
                  <Chip
                    key={suggestion}
                    label={suggestion}
                    accent={accent.accent}
                    accentWash={accent.wash}
                    onPress={() => patch({ query: suggestion })}
                  />
                ))}
              </ChipRail>
            </EmptyState>
          ) : (
            <EmptyState
              headline={`Nothing matching “${trimmed}”`}
              caption={
                mode === 'fashion' && search.brands.length + search.sizes.length > 0
                  ? 'No retailer returned a match with these filters. Clearing the brand or size filter usually widens it.'
                  : 'No retailer carried a match in the last sweep. Try a shorter or more common name.'
              }
              icon="search-outline"
              style={styles.filler}
            />
          )
        }
        renderItem={({ item, index }) => (
          <RetailerGroup
            retailer={item.retailer}
            offers={item.offers}
            mode={mode}
            cheapest={index === 0}
            onOpen={openOffer}
          />
        )}
      />
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
    flexGrow: 1,
  },
  controls: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  field: {
    marginHorizontal: layout.screenPadding,
  },
  loadingCard: {
    marginTop: spacing.sm,
  },
  filler: {
    paddingVertical: spacing.huge,
  },
  suggestions: {
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
});
