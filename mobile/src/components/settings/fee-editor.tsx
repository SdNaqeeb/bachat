/**
 * Per-retailer delivery and handling fees (spec §8).
 *
 * These are typed by the user and never scraped, which is a deliberate design
 * decision rather than a gap: fees vary by cart value, by time of day and by
 * whatever membership the user happens to hold, and a scraped fee that is
 * confidently wrong would corrupt the one number the whole app is built on.
 *
 * That makes this screen load-bearing for the Basket's ranking, so it says so
 * plainly. A retailer left at zero is shown as "no fee" rather than blank —
 * blank reads as "not set up yet" and this app should never make the user
 * wonder whether a total is complete.
 */

import { StyleSheet, Text, View } from 'react-native';

import { NumberField } from '@/components/ui/text-field';
import { RetailerBadge } from '@/components/ui/retailer-badge';
import { rupees } from '@/lib/format';
import type { Retailer, RetailerFees } from '@/lib/types';
import { layout, palette, spacing, type } from '@/theme';

export type FeeEditorProps = {
  retailers: Retailer[];
  fees: Record<string, RetailerFees>;
  onChange: (retailerId: string, fees: RetailerFees) => void;
  accent: string;
};

export function FeeEditor({ retailers, fees, onChange, accent }: FeeEditorProps) {
  return (
    <View>
      <View style={styles.headRow}>
        <View style={styles.headSpacer} />
        <Text maxFontSizeMultiplier={1.2} style={styles.headLabel}>
          Delivery
        </Text>
        <Text maxFontSizeMultiplier={1.2} style={styles.headLabel}>
          Handling
        </Text>
      </View>

      {retailers.map((retailer, index) => {
        const current = fees[retailer.id] ?? { deliveryFee: 0, handlingFee: 0 };
        const total = current.deliveryFee + current.handlingFee;

        return (
          <View key={retailer.id} style={[styles.row, index > 0 && styles.rowDivided]}>
            <View style={styles.identity}>
              <RetailerBadge retailer={retailer} size={28} />
              <View style={styles.identityText}>
                <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.name}>
                  {retailer.name}
                </Text>
                <Text maxFontSizeMultiplier={1.3} style={styles.total}>
                  {total > 0 ? `${rupees(total)} on top` : 'No fee'}
                </Text>
              </View>
            </View>

            <NumberField
              value={current.deliveryFee}
              accent={accent}
              accessibilityLabel={`${retailer.name} delivery fee`}
              onChange={(deliveryFee) => onChange(retailer.id, { ...current, deliveryFee })}
              style={styles.input}
            />
            <NumberField
              value={current.handlingFee}
              accent={accent}
              accessibilityLabel={`${retailer.name} handling fee`}
              onChange={(handlingFee) => onChange(retailer.id, { ...current, handlingFee })}
              style={styles.input}
            />
          </View>
        );
      })}

      <Text maxFontSizeMultiplier={1.4} style={styles.note}>
        Bachat adds these to every basket total, which is what stops a cheap cart with an
        expensive delivery from looking like the winner.
      </Text>
    </View>
  );
}

const FIELD_WIDTH = 78;

const styles = StyleSheet.create({
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  headSpacer: {
    flex: 1,
  },
  headLabel: {
    ...type.tag,
    color: palette.textMuted,
    width: FIELD_WIDTH,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  rowDivided: {
    borderTopWidth: layout.hairline,
    borderTopColor: palette.line,
  },
  identity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  identityText: {
    flex: 1,
  },
  name: {
    ...type.rowTitle,
    color: palette.textPrimary,
  },
  total: {
    ...type.caption,
    color: palette.textMuted,
  },
  input: {
    width: FIELD_WIDTH,
  },
  note: {
    ...type.caption,
    color: palette.textSecondary,
    marginTop: spacing.md,
  },
});
