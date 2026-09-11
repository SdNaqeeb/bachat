/**
 * The list of regulars, always editable in place.
 *
 * This list gets edited more than anything else in the app — milk goes up to
 * three, dal comes off, coriander goes on — so there is no edit mode to enter
 * and no sheet to open. Quantity is a stepper, removal is one tap, and the add
 * field sits permanently at the end of the list rather than behind a floating
 * button, because a field you can see is a field you will use.
 *
 * A new item needs a category (it gates the sweep and the alerts, spec §7), so
 * the category rail appears only once there is something to file — asking for
 * it before the user has typed a word would be a form, and this is a list.
 *
 * Edits are handed up immediately and the screen decides when to persist; a
 * round trip per keystroke on the plus button would make the stepper feel like
 * treacle on a slow connection.
 */

import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, IconButton } from '@/components/ui/button';
import { Chip, ChipRail } from '@/components/ui/chip';
import { RowDivider } from '@/components/ui/price-row';
import { Stepper } from '@/components/ui/stepper';
import { TextField } from '@/components/ui/text-field';
import type { BasketItem, Category, Mode } from '@/lib/types';
import { layout, palette, spacing, type } from '@/theme';

export type BasketEditorProps = {
  items: BasketItem[];
  categories: Category[];
  mode: Mode;
  /** The current mode's accent, for the focus ring and the category chips. */
  accent: string;
  accentWash: string;
  /** Called with the whole new list. The screen persists and refetches. */
  onChange: (items: BasketItem[]) => void;
};

export function BasketEditor({
  items,
  categories,
  mode,
  accent,
  accentWash,
  onChange,
}: BasketEditorProps) {
  const [draft, setDraft] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);

  const fallbackCategory = categories[0]?.id ?? '';
  const labelFor = useMemo(() => {
    const map = new Map(categories.map((category) => [category.id, category.label]));
    return (id: string) => map.get(id) ?? id;
  }, [categories]);

  const setQty = useCallback(
    (id: string, qty: number) => {
      onChange(items.map((item) => (item.id === id ? { ...item, qty } : item)));
    },
    [items, onChange]
  );

  const remove = useCallback(
    (id: string) => {
      onChange(items.filter((item) => item.id !== id));
    },
    [items, onChange]
  );

  const add = useCallback(() => {
    const label = draft.trim();
    if (label.length === 0) return;
    onChange([
      ...items,
      {
        // Replaced by the server's id on the next fetch; unique enough until then.
        id: `local-${Date.now()}`,
        label,
        qty: 1,
        mode,
        category: categoryId ?? fallbackCategory,
      },
    ]);
    setDraft('');
    setCategoryId(null);
  }, [draft, items, mode, categoryId, fallbackCategory, onChange]);

  return (
    <View>
      {items.map((item, index) => (
        <View key={item.id}>
          {index > 0 ? <RowDivider style={styles.divider} /> : null}
          <View style={styles.row}>
            <View style={styles.rowBody}>
              <Text numberOfLines={2} maxFontSizeMultiplier={1.3} style={styles.label}>
                {item.label}
              </Text>
              <Text maxFontSizeMultiplier={1.3} style={styles.category}>
                {labelFor(item.category)}
              </Text>
            </View>

            <Stepper
              value={item.qty}
              itemLabel={item.label}
              onChange={(qty) => setQty(item.id, qty)}
            />
            <IconButton
              icon="trash-outline"
              tone="danger"
              label={`Remove ${item.label}`}
              onPress={() => remove(item.id)}
            />
          </View>
        </View>
      ))}

      <View style={styles.composer}>
        <TextField
          value={draft}
          onChangeText={setDraft}
          accent={accent}
          icon="add"
          placeholder={
            mode === 'quick' ? 'Add an item, e.g. Amul Taaza 500 ml' : 'Add an item, e.g. white tee, M'
          }
          returnKeyType="done"
          onSubmitEditing={add}
          accessibilityLabel="New basket item"
        />

        {draft.trim().length > 0 ? (
          <View style={styles.filing}>
            <Text maxFontSizeMultiplier={1.3} style={styles.filingLabel}>
              File it under
            </Text>
            <ChipRail>
              {categories.map((category) => (
                <Chip
                  key={category.id}
                  label={category.label}
                  selected={(categoryId ?? fallbackCategory) === category.id}
                  accent={accent}
                  accentWash={accentWash}
                  onPress={() => setCategoryId(category.id)}
                />
              ))}
            </ChipRail>
            <Button label="Add to basket" size="sm" onPress={add} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: layout.rowHeight,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  divider: {
    marginLeft: spacing.lg,
  },
  rowBody: {
    flex: 1,
    gap: spacing.xxs,
  },
  label: {
    ...type.rowTitle,
    color: palette.textPrimary,
  },
  category: {
    ...type.caption,
    color: palette.textMuted,
  },
  composer: {
    padding: spacing.lg,
    gap: spacing.md,
    borderTopWidth: layout.hairline,
    borderTopColor: palette.line,
    backgroundColor: palette.surfaceRaised,
  },
  filing: {
    gap: spacing.md,
  },
  filingLabel: {
    ...type.caption,
    color: palette.textSecondary,
  },
});
