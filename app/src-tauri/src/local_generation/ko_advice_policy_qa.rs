//! Closed writer-policy experiment; source evidence and execution authority stay unchanged.
use super::{failure, ActivityFlowFailure};
use serde::Serialize;

const CONTROL_POLICY: &str = include_str!("../local_work_advice_policy_ko.txt");
const OLD_BRANCHES: &str = "- 계획이나 요청만 있다면, 그 계획이 아직 유효하다는 조건 아래 실제로 할 수 있는 작은 첫 행동을 제안하세요. 완료 여부를 확인하라는 말로 끝내지 마세요.\n- 미완료가 명시되면 기록된 우선순위대로 다음 행동을 제안하세요. 작업 순서가 정해져 있다면 먼저 할 일과 그다음 할 일을 함께 알려주세요.\n- 완료된 작업은 다시 하라고 제안하지 마세요. 다음 목표가 기록되지 않았다면 완료된 작업의 이름을 짚고 다음 목표를 직접 질문하세요.\n- 일반 정보만 있다면 개인적인 할 일을 지어내지 말고 사용자의 목표를 직접 질문하세요.";
const NEW_BRANCHES: &str = "- 사용자 자신의 요청·계획·결정·조사 목적이 있으면, 현재도 유효하다는 조건으로 기록된 순서에 맞는 작은 첫 행동을 제안하세요. 확인 질문만으로 끝내지 마세요.\n- 완료한 단계를 반복시키지 마세요. 과거의 완료·취소·되돌림·조사 재개는 현재 미완료·의무·우선순위가 아닙니다. 기록된 중단 이유나 조사 목적은, 계속 그 목표를 추구한다는 조건 아래 새 조사·확인을 제안할 근거가 될 수 있습니다.\n- 다른 행위자의 결과 보고나 미검증만으로 사용자 할 일을 만들지 마세요. 전체 목표 완료 뒤 다음 목적이 없거나 일반 정보만 있다면 현재 목표를 직접 질문하세요.";

/// Feature-only diagnostic choice, never a product setting or model route.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum KoAdvicePolicyQa {
    ExistingControl,
    IntentConditionalV1,
}

impl KoAdvicePolicyQa {
    /// Stable arm identity for source-bound diagnostic observations.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExistingControl => "ExistingControl",
            Self::IntentConditionalV1 => "IntentConditionalV1",
        }
    }

    /// Exact writer-only delta; neither branch contains reference answers.
    pub const fn branches(self) -> &'static str {
        match self {
            Self::ExistingControl => OLD_BRANCHES,
            Self::IntentConditionalV1 => NEW_BRANCHES,
        }
    }

    pub(super) fn apply(
        self,
        language: &str,
        system: &mut String,
    ) -> Result<(), ActivityFlowFailure> {
        // The existing path does not parse, validate or rewrite its instructions.
        if self == Self::ExistingControl {
            return Ok(());
        }
        if language != "ko"
            || !system.starts_with(CONTROL_POLICY)
            || CONTROL_POLICY.matches(OLD_BRANCHES).count() != 1
            || system.matches(OLD_BRANCHES).count() != 1
        {
            return Err(failure(
                "review_invalid",
                "KO advice QA policy prefix or exact branch identity changed",
            ));
        }
        let next = system.replacen(OLD_BRANCHES, NEW_BRANCHES, 1);
        *system = next;
        Ok(())
    }
}

#[cfg(test)]
#[path = "ko_advice_policy_qa_tests.rs"]
mod tests;
