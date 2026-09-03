begin;

update public.categories
set color = case
  when btrim(coalesce(color, '')) ~ '^[0-9A-Fa-f]{6}$' then '#' || upper(btrim(color))
  when btrim(coalesce(color, '')) ~ '^#[0-9A-Fa-f]{6}$' then upper(btrim(color))
  else '#5D7D91'
end;

update public.categories
set icon = case lower(btrim(coalesce(icon, '')))
  when 'briefcase.fill' then 'briefcase'
  when 'banknote.fill' then 'banknote'
  when 'cart.fill' then 'basket'
  when 'wineglass.fill' then 'wine'
  when 'play.tv.fill' then 'tv'
  when 'house.fill' then 'house'
  when 'exclamationmark.shield.fill' then 'shield'
  when 'bag.fill' then 'shopping-bag'
  when 'bolt.fill' then 'zap'
  when 'target' then 'target'
  when 'car.fill' then 'car'
  when 'cross.case.fill' then 'medical'
  when 'creditcard.fill' then 'credit-card'
  when 'airplane' then 'plane'
  when 'fork.knife' then 'utensils'
  when '' then case
    when lower(name) ~ 'salary|business' then 'briefcase'
    when lower(name) ~ 'income|saving|dividend|investment|emergency fund' then 'banknote'
    when lower(name) ~ 'grocer' then 'basket'
    when lower(name) ~ 'going out|per diem' then 'utensils'
    when lower(name) ~ 'leisure' then 'tv'
    when lower(name) ~ 'transport|car' then 'car'
    when lower(name) ~ 'apartment|rent' then 'house'
    when lower(name) ~ 'insurance' then 'shield'
    when lower(name) ~ 'shopping' then 'shopping-bag'
    when lower(name) ~ 'utilit' then 'zap'
    when lower(name) ~ 'cleaning' then 'target'
    when lower(name) ~ 'gym' then 'dumbbell'
    when lower(name) ~ 'medical' then 'medical'
    when lower(name) ~ 'subscription' then 'credit-card'
    when lower(name) ~ 'travel' then 'plane'
    when lower(name) ~ 'tax|fee|expense' then 'receipt'
    when lower(name) ~ 'charity' then 'heart'
    else 'sparkles'
  end
  else lower(btrim(icon))
end;

commit;
