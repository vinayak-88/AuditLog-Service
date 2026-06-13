'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { FormEvent } from 'react';

const fields = ['actorId', 'action', 'resourceId', 'resourceType'] as const;

export function SearchFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const params = new URLSearchParams();

    for (const field of fields) {
      const value = String(formData.get(field) || '');
      if (value) params.set(field, value);
    }

    router.push(`/dashboard/events?${params.toString()}`);
  }

  return (
    <form className="toolbar card" onSubmit={onSubmit}>
      {fields.map((field) => (
        <div className="field" key={field}>
          <label htmlFor={field}>{field}</label>
          <input className="input" id={field} name={field} defaultValue={searchParams.get(field) || ''} />
        </div>
      ))}
      <button className="button" type="submit" title="Search events">
        <Search size={16} aria-hidden />
        Search
      </button>
    </form>
  );
}
