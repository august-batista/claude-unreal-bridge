// Fixture automation tests for verifying the run-tests bridge tool.
// Two tests: one always passes, one always fails — together they let us
// verify both code paths in the report parser.
//
// To opt out of the failing one in production, change Sandbox.NegativeFixture
// to Sandbox.Disabled.NegativeFixture or remove the registration.

#include "CoreMinimal.h"
#include "Misc/AutomationTest.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FSandboxSanityAlwaysPassesTest,
	"Sandbox.Sanity.AlwaysPasses",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter
)

bool FSandboxSanityAlwaysPassesTest::RunTest(const FString& Parameters)
{
	TestEqual(TEXT("one plus one equals two"), 1 + 1, 2);
	TestTrue(TEXT("true is true"), true);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FSandboxNegativeFixtureAlwaysFailsTest,
	"Sandbox.NegativeFixture.AlwaysFails",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter
)

bool FSandboxNegativeFixtureAlwaysFailsTest::RunTest(const FString& Parameters)
{
	AddError(TEXT("Intentional failure: this fixture validates the run-tests parser handles errors."));
	return false;
}
