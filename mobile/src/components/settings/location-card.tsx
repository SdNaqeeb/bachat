/**
 * Where the prices are collected from (spec §6).
 *
 * Quick-commerce prices are dark-store specific: Blinkit takes a lat/lon and
 * resolves a merchant, BigBasket takes a pincode. Get this wrong and every
 * number in the app is quietly for the wrong part of the city — which is the
 * kind of failure that looks like working software — so the card explains what
 * the two fields are actually for rather than just labelling them.
 *
 * The coordinates are optional and say so. A pincode alone gets BigBasket
 * right; without coordinates Blinkit falls back to its default store, and the
 * copy states that trade-off instead of leaving an empty field looking broken.
 */

import { StyleSheet, Text, View } from 'react-native';

import { TextField } from '@/components/ui/text-field';
import { palette, spacing, type } from '@/theme';

export type LocationCardProps = {
  pincode: string;
  lat: number | null;
  lon: number | null;
  onChange: (partial: { pincode?: string; lat?: number | null; lon?: number | null }) => void;
  accent: string;
};

/** Parses a typed coordinate, treating an empty or half-typed field as unset. */
function parseCoordinate(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === '-' || trimmed.endsWith('.')) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function LocationCard({ pincode, lat, lon, onChange, accent }: LocationCardProps) {
  return (
    <View style={styles.root}>
      <TextField
        value={pincode}
        onChangeText={(next) => onChange({ pincode: next.replace(/[^0-9]/g, '').slice(0, 6) })}
        accent={accent}
        icon="location-outline"
        keyboardType="number-pad"
        placeholder="560103"
        accessibilityLabel="Delivery pincode"
      />

      <View style={styles.pair}>
        <TextField
          value={lat === null ? '' : String(lat)}
          onChangeText={(next) => onChange({ lat: parseCoordinate(next) })}
          accent={accent}
          keyboardType="numbers-and-punctuation"
          placeholder="Latitude"
          accessibilityLabel="Latitude"
          style={styles.half}
        />
        <TextField
          value={lon === null ? '' : String(lon)}
          onChangeText={(next) => onChange({ lon: parseCoordinate(next) })}
          accent={accent}
          keyboardType="numbers-and-punctuation"
          placeholder="Longitude"
          accessibilityLabel="Longitude"
          style={styles.half}
        />
      </View>

      <Text maxFontSizeMultiplier={1.4} style={styles.note}>
        {lat === null || lon === null
          ? 'BigBasket uses the pincode. Blinkit needs coordinates to pick the right dark store — without them it prices against its default one.'
          : 'BigBasket uses the pincode; Blinkit uses the coordinates to pick your nearest dark store.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.md,
  },
  pair: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  half: {
    flex: 1,
  },
  note: {
    ...type.caption,
    color: palette.textSecondary,
  },
});
