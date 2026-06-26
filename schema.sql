-- Delivery Montblanc — schema isolado no namespace "montblanc"

CREATE SCHEMA IF NOT EXISTS montblanc;

CREATE TABLE IF NOT EXISTS montblanc.users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone         TEXT,
  apartment     TEXT,
  is_master     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS montblanc.categories (
  id   SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

INSERT INTO montblanc.categories (name) VALUES
  ('Bebidas'), ('Massas'), ('Perecíveis'), ('Água'), ('Chocolates')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS montblanc.products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cat         TEXT NOT NULL,
  price       NUMERIC(10,2) NOT NULL,
  unit        TEXT NOT NULL,
  icon        TEXT DEFAULT 'ph-package',
  description TEXT DEFAULT '',
  rating      NUMERIC(3,1) DEFAULT 5.0,
  sold        INTEGER DEFAULT 0,
  tag         TEXT DEFAULT '',
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO montblanc.products (id, name, cat, price, unit, icon, description, rating, sold, tag) VALUES
  ('p1',  'Refrigerante Cola 2L',     'Bebidas',     9.90,  'Garrafa 2L',    'ph-bottle',      'Refrigerante de cola, servido sempre gelado. Ideal para acompanhar a refeição em família.', 4.8, 132, 'Mais vendido'),
  ('p2',  'Guaraná Lata 350ml',       'Bebidas',     4.50,  'Lata 350ml',    'ph-bottle',      'Guaraná gelado em lata individual.',                                                        4.7,  98, ''),
  ('p3',  'Suco de Laranja 1L',       'Bebidas',    12.00,  'Garrafa 1L',    'ph-orange-slice', 'Suco natural de laranja espremido na hora, sem conservantes.',                             4.9,  54, 'Natural'),
  ('p4',  'Macarrão Caseiro 500g',    'Massas',     18.00,  'Porção 500g',   'ph-bowl-food',   'Massa fresca caseira, feita com ovos e farinha selecionada. Cozinha em 3 minutos.',         5.0,  76, 'Da casa'),
  ('p5',  'Lasanha à Bolonhesa',      'Massas',     32.00,  'Travessa 800g', 'ph-bowl-food',   'Lasanha congelada à bolonhesa com molho artesanal e muito queijo. Serve até 2 pessoas.',    4.9,  64, 'Congelado'),
  ('p6',  'Nhoque da Nonna 600g',     'Massas',     24.00,  'Porção 600g',   'ph-bowl-food',   'Nhoque de batata feito à mão, receita de família.',                                         5.0,  41, ''),
  ('p7',  'Água Mineral 1,5L',        'Água',        3.50,  'Garrafa 1,5L',  'ph-drop',        'Água mineral natural sem gás.',                                                             4.6, 210, ''),
  ('p8',  'Água com Gás 500ml',       'Água',        4.00,  'Garrafa 500ml', 'ph-drop',        'Água mineral com gás, geladinha.',                                                          4.5,  88, ''),
  ('p9',  'Chocolate ao Leite 90g',   'Chocolates',  8.50,  'Barra 90g',     'ph-cookie',      'Chocolate ao leite cremoso.',                                                               4.8, 120, ''),
  ('p10', 'Brigadeiro Gourmet (6un)', 'Chocolates', 22.00,  'Caixa com 6',   'ph-cookie',      'Brigadeiros gourmet feitos com chocolate belga. Embalagem para presente.',                  5.0,  73, 'Novo'),
  ('p11', 'Queijo Minas 500g',        'Perecíveis', 28.00,  'Peça 500g',     'ph-egg',         'Queijo minas frescal artesanal.',                                                           4.9,  35, ''),
  ('p12', 'Iogurte Natural 500g',     'Perecíveis', 11.00,  'Pote 500g',     'ph-egg',         'Iogurte natural integral, sem açúcar.',                                                     4.7,  47, '')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS montblanc.orders (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES montblanc.users(id),
  apartment  TEXT NOT NULL,
  payment    TEXT NOT NULL,
  total      NUMERIC(10,2) NOT NULL,
  status     TEXT DEFAULT 'confirmed',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS montblanc.order_items (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER REFERENCES montblanc.orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES montblanc.products(id),
  quantity   INTEGER NOT NULL,
  price      NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS montblanc.favorites (
  user_id    INTEGER REFERENCES montblanc.users(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES montblanc.products(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, product_id)
);
