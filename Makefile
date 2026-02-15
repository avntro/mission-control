.PHONY: test test-cov test-unit test-integration

test:
	cd backend && python -m pytest ../tests/ -v

test-cov:
	cd backend && python -m pytest ../tests/ -v --cov=. --cov-report=term-missing

test-unit:
	cd backend && python -m pytest ../tests/test_models.py ../tests/test_utils.py -v

test-integration:
	cd backend && python -m pytest ../tests/test_api_*.py -v
