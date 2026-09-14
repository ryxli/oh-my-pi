# Scene: {{label}}

## Authoritative state
{{#each state}}
- {{this}}
{{/each}}
{{#if evidence}}

## Evidence
{{#each evidence}}
- {{this}}
{{/each}}
{{/if}}
{{#if artifacts}}

## Artifacts
{{#each artifacts}}
- {{this}}
{{/each}}
{{/if}}

## Objective
{{objective}}

## Exit condition
{{exit}}
