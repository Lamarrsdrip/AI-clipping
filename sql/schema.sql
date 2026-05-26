create table if not exists users (
  id text primary key,
  name text not null,
  email text not null unique,
  plan text not null default 'starter',
  credits integer not null default 120,
  role text not null default 'member',
  created_at timestamptz not null default now()
);

create table if not exists imports (
  id text primary key,
  user_id text not null references users(id),
  source_url text not null,
  source_type text not null check (source_type in ('video', 'channel')),
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists videos (
  id text primary key,
  import_id text not null references imports(id),
  youtube_id text not null,
  url text not null,
  title text not null,
  channel_title text,
  duration_seconds integer,
  published_at timestamptz,
  thumbnail_url text,
  selected boolean not null default false,
  rights_confirmed boolean not null default false,
  fair_use_mode boolean not null default false,
  transformation_note text,
  status text not null default 'imported'
);

create table if not exists jobs (
  id text primary key,
  user_id text not null references users(id),
  video_id text not null references videos(id),
  status text not null,
  progress integer not null default 0,
  stage text not null default 'queued',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists clips (
  id text primary key,
  job_id text not null references jobs(id),
  video_id text not null references videos(id),
  title text not null,
  hook text not null,
  start_seconds numeric not null,
  end_seconds numeric not null,
  score integer not null,
  rationale text,
  transcript_excerpt text,
  output_path text,
  thumbnail_path text,
  platform text not null,
  post_caption text,
  hashtags text[] not null default '{}',
  status text not null default 'ready'
);

create table if not exists watched_channels (
  id text primary key,
  user_id text not null references users(id),
  source_url text not null,
  status text not null default 'active',
  rights_confirmed boolean not null default false,
  fair_use_mode boolean not null default false,
  transformation_note text,
  auto_process boolean not null default true,
  auto_schedule boolean not null default false,
  platforms text[] not null default '{}',
  known_video_ids text[] not null default '{}',
  last_checked_at timestamptz,
  last_result text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists social_accounts (
  id text primary key,
  user_id text not null references users(id),
  platform text not null,
  handle text not null,
  status text not null default 'saved',
  oauth_status text not null default 'not_connected',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists scheduled_posts (
  id text primary key,
  clip_id text not null references clips(id),
  platform text not null,
  account_id text references social_accounts(id),
  scheduled_for timestamptz not null,
  status text not null default 'scheduled',
  caption text,
  created_at timestamptz not null default now()
);
