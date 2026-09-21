import { Component, computed, inject, signal } from '@angular/core';
import type { InterventionAction, LocalizedMessage, RescuePlan } from '@focusloop/shared-types';
import { AppStateService } from '../core/app-state.service';
import { I18nService } from '../core/i18n/i18n.service';
import { ACTION_KEYS } from '../core/i18n/labels';

/** One offered → active → continued surface for explicit AG2 help requests. */
@Component({
  selector: 'fl-agent-panel',
  standalone: true,
  template: `
    @if (rescue(); as card) {
      @if (card.phase === 'offered') {
        <aside
          class="agent agent--rescue"
          role="status"
          aria-live="polite"
          data-testid="agent-offered"
          [attr.data-action]="card.decision.action"
          (keydown.escape)="resolve('dismiss')"
        >
          <p class="eyebrow">{{ t('agent.suggesting') }}</p>
          <h3>{{ copy(card.decision.action) }}</h3>
          <p class="muted small agent__reason">{{ reason(card.decision) }}</p>
          <p class="muted small agent__estimate">
            {{ minutes(card.decision.estimatedMinutes) }}
          </p>
          <div class="agent__actions">
            <button
              type="button"
              class="btn btn--small btn--primary"
              data-testid="agent-accept"
              [disabled]="pending()"
              (click)="resolve('accept')"
            >
              {{ pending() ? t('agent.accepting') : t('agent.accept') }}
            </button>
            <button
              type="button"
              class="btn btn--small btn--ghost"
              data-testid="agent-not-now"
              [disabled]="pending()"
              (click)="resolve('dismiss')"
            >
              {{ t('agent.notNow') }}
            </button>
          </div>
        </aside>
      } @else if (card.plan; as plan) {
        <aside
          class="agent agent--rescue agent--accepted"
          role="status"
          aria-live="polite"
          data-testid="agent-accepted"
          [attr.data-action]="card.decision.action"
        >
          <p class="eyebrow">{{ t('agent.rescue.ready') }}</p>
          <h3>{{ t('agent.rescue.title') }}</h3>
          <p class="muted small">{{ reason(card.decision) }}</p>
          <ol class="agent__plan" [attr.aria-label]="t('agent.rescue.plan')">
            @for (step of plan.steps; track $index) {
              <li>{{ stepText(step) }}</li>
            }
          </ol>
          <button
            type="button"
            class="btn btn--small btn--primary"
            data-testid="agent-continue"
            [disabled]="pending()"
            (click)="resolve('continue')"
          >
            {{ t('agent.continue') }}
          </button>
        </aside>
      }
    } @else if (offered(); as value) {
      @if (visible(value.action)) {
        <aside class="agent" role="status" [attr.data-action]="value.action">
          <p class="eyebrow">{{ t('agent.suggesting') }}</p>
          <h3>{{ copy(value.action) }}</h3>
          <p class="muted small">{{ reason(value) }} · {{ minutes(value.estimatedMinutes) }}</p>
          <div class="agent__actions">
            <button type="button" class="btn btn--small btn--primary" (click)="generic(true)">
              {{ t('agent.showMe') }}
            </button>
            <button type="button" class="btn btn--small btn--ghost" (click)="generic(false)">
              {{ t('agent.notNow') }}
            </button>
          </div>
        </aside>
      }
    }
  `,
})
export class AgentPanelComponent {
  private readonly state = inject(AppStateService);
  private readonly i18n = inject(I18nService);

  protected readonly t = this.i18n.t;
  protected readonly rescue = this.state.rescue;
  protected readonly offered = computed(() =>
    this.state.rescue() === null ? this.state.decision() : null,
  );
  protected readonly pending = signal(false);

  protected visible(action: InterventionAction): boolean {
    return action !== 'NO_ACTION' && action !== 'RESUME';
  }

  protected copy(action: InterventionAction): string {
    return this.t(ACTION_KEYS[action]);
  }

  protected reason(value: { readonly reason: LocalizedMessage }): string {
    return this.i18n.translate(value.reason);
  }

  protected stepText(step: RescuePlan['steps'][number]): string {
    return this.i18n.translate(step);
  }

  protected minutes(value: number): string {
    return this.t('agent.estimate', { minutes: `${value}` });
  }

  protected async resolve(resolution: 'accept' | 'dismiss' | 'continue'): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    await this.state.resolveRescue(resolution);
    this.pending.set(false);
  }

  protected generic(accepted: boolean): void {
    void this.state.dismissIntervention(accepted);
  }
}
